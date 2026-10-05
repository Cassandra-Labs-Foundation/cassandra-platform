// Investment portfolio — IP-02..IP-17.
//
// The negatives: an instrument class not on the permitted list (absence means
// NO under 12 CFR 703), an unapproved counterparty, a concentration limit
// tested on the projected position, the executing trader confirming or settling
// their own trade, a confirmation that does not match the counterparty, a repo
// short of margin, a fair value with no source, and a contingency level
// activated with no execution plan.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { makeDrillDb } from "../drill/fake_db.ts";
import { OPS_CTX, req } from "./test_helpers.ts";
import {
  REQUIRED_TRADE_DOCUMENTS,
  evaluateTradeGate,
  instrumentEntryInForce,
  postAlmSimulation,
  postCfpLevelChange,
  postCreditFile,
  postFairValue,
  postInstrumentListEntry,
  postIntermediary,
  postLiquidityClassification,
  postLiquidityReport,
  postPerformanceMeasurement,
  postRepoAgreement,
  postSafekeepingReconciliation,
  postSecurityDowngrade,
  postTrade,
  postTradeConfirmation,
  postTradeException,
  postTradeReconciliation,
  putLimitSet,
  putUserRole,
} from "./investment.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const CTX = OPS_CTX;
// IP-14 binds each duty to the AUTHENTICATED caller, so each role acts under
// its own credential — the token id is the role-register key.
const TRADER = { ...OPS_CTX, tokenId: "trader_1", idempotencyScope: "token:trader_1" };
const CONFIRMER = { ...OPS_CTX, tokenId: "ops_confirm", idempotencyScope: "token:ops_confirm" };
const codes = (rows: Record<string, Any[]>) =>
  (rows["core.event"] ?? []).map((e) => String(e.code));

/**
 * The drill fake has no `.range()`; the handlers page whole-register reads
 * with it (PostgREST caps an unpaged select at 1000 rows). Test data is far
 * below one page, so range(0, n) is limit(n + 1) and any later page is empty.
 */
// deno-lint-ignore no-explicit-any
function withRange(client: any): any {
  // deno-lint-ignore no-explicit-any
  const wrap = (chain: any): any =>
    new Proxy({}, {
      get(_t, prop) {
        if (prop === "range") {
          return (from: number, to: number) =>
            from === 0
              ? wrap(chain.limit(to - from + 1))
              : { then: (f: (v: Any) => Any) => Promise.resolve({ data: [], error: null }).then(f) };
        }
        const v = chain[prop];
        if (typeof v !== "function") return v;
        return (...args: Any[]) => {
          const out = v(...args);
          return out === chain || (out && typeof out === "object" && "eq" in out && "then" in out)
            ? wrap(out)
            : out;
        };
      },
    });
  return {
    schema(s: string) {
      const sc = client.schema(s);
      return { from: (t: string) => wrap(sc.from(t)), rpc: sc.rpc };
    },
  };
}

/** A book that can trade: list, counterparty, capital, limit, securities, roles. */
async function seedBook(opts: { limitBp?: number; warnBp?: number } = {}) {
  const dbx = makeDrillDb();
  const db = withRange(dbx.client);
  dbx.rows["core.capital_position"] = [{
    id: "cap_1", as_of_date: "2026-03-31", net_worth_cents: 750_000_000,
    total_assets_cents: 5_000_000_000, net_worth_ratio_bp: 1500,
    pca_category: "well_capitalized", provenance: "production",
  }];
  await postInstrumentListEntry(
    req({
      instrument_class: "us_treasury", permissible: true, citation: "12 CFR 703.14(a)",
      max_maturity_months: 120, effective_at: "2026-01-01T00:00:00.000Z",
    }),
    db, "t", CTX,
  );
  await postInstrumentListEntry(
    req({
      instrument_class: "cmo", permissible: false, citation: "12 CFR 703.16",
      effective_at: "2026-01-01T00:00:00.000Z",
    }),
    db, "t", CTX,
  );
  await postIntermediary(
    req({ name: "Northgate", kind: "both", regulator: "finra", registration_status: "active" }),
    db, "t", CTX,
  );
  await putLimitSet(
    req({
      scope_kind: "issuer", scope_ref: "us_gov",
      limit_bp_of_capital: opts.limitBp ?? 5000,
      warning_bp_of_capital: opts.warnBp ?? 4000,
      approved_by: "board-1", effective_at: "2026-01-01T00:00:00.000Z",
    }),
    db, "t", CTX,
  );
  dbx.rows["core.security"] = [
    { id: "sec_1", issuer_ref: "us_gov", instrument_class: "us_treasury", provenance: "production" },
    { id: "sec_2", issuer_ref: "acme", instrument_class: "cmo", provenance: "production" },
    { id: "sec_x", issuer_ref: "us_gov", instrument_class: "crypto", provenance: "production" },
  ];
  for (const [u, role] of [["trader_1", "execution"], ["ops_confirm", "confirmation"]]) {
    await putUserRole(req({ role }), u, db, "t", CTX);
  }
  return { dbx, db };
}

const buy = (o: Record<string, unknown> = {}) => req({
  security_id: "sec_1", instrument_class: "us_treasury", issuer_ref: "us_gov",
  intermediary_id: "interm_northgate", side: "buy", par_cents: 30_000_000,
  price_bp: 9950, executed_by: "trader_1", maturity_months: 60,
  checklist_completed: true, ...o,
});

// ------------------------------------------------------ IP-03 permissibility

Deno.test("IP-03: an instrument class NOT on the list is refused — absence means no", async () => {
  const { dbx, db } = await seedBook();
  const res = await postTrade(
    buy({ security_id: "sec_x", instrument_class: "crypto", issuer_ref: "us_gov" }), db, "t", TRADER,
  );
  assertEquals(res.status, 409);
  assertEquals(dbx.rows["core.trade"][0].permissibility_verdict, "unassessed");
  assertEquals(dbx.rows["core.trade"][0].decision, "blocked");
  assert(codes(dbx.rows).includes("trade.blocked_prohibited"));
});

Deno.test("IP-03: an explicitly prohibited class is refused", async () => {
  const { dbx, db } = await seedBook();
  const res = await postTrade(
    buy({ security_id: "sec_2", instrument_class: "cmo", issuer_ref: "acme" }), db, "t", TRADER,
  );
  assertEquals(res.status, 409);
  assertEquals(dbx.rows["core.trade"][0].permissibility_verdict, "prohibited");
});

Deno.test("IP-03: maturity beyond the list limit is prohibited", async () => {
  const { dbx, db } = await seedBook();
  const res = await postTrade(buy({ maturity_months: 240 }), db, "t", TRADER);
  assertEquals(res.status, 409);
  assert(
    (dbx.rows["core.trade"][0].blocked_reasons as string[]).includes("maturity_exceeds_list_limit"),
  );
});

Deno.test("IP-03: the list is effective-dated", async () => {
  const { db } = await seedBook();
  await postInstrumentListEntry(
    req({
      instrument_class: "us_treasury", permissible: false, citation: "c",
      effective_at: "2027-01-01T00:00:00.000Z",
    }),
    db, "t", CTX,
  );
  const now = await instrumentEntryInForce(db, "core", "us_treasury", new Date("2026-07-01T00:00:00Z"));
  assertEquals(now!.permissible, true);
  const later = await instrumentEntryInForce(db, "core", "us_treasury", new Date("2027-06-01T00:00:00Z"));
  assertEquals(later!.permissible, false);
});

// ------------------------------------------------------ IP-08 counterparties

Deno.test("IP-08: an unregulated counterparty is not approved and blocks the trade", async () => {
  const { dbx, db } = await seedBook();
  await postIntermediary(
    req({ name: "Backstreet", kind: "broker_dealer", regulator: "none", registration_status: "active" }),
    db, "t", CTX,
  );
  const im = dbx.rows["core.intermediary"].find((i) => i.id === "interm_backstreet");
  assertEquals(im!.approved, false);
  const res = await postTrade(buy({ intermediary_id: "interm_backstreet" }), db, "t", TRADER);
  assertEquals(res.status, 409);
  assert(codes(dbx.rows).includes("trade.intermediary.blocked"));
});

Deno.test("IP-08: a trade with NO counterparty is refused", async () => {
  const { db } = await seedBook();
  const res = await postTrade(buy({ intermediary_id: undefined }), db, "t", TRADER);
  assertEquals(res.status, 409);
});

Deno.test("IP-08: safekeeping reconciliation compares OUR book to the custodian's", async () => {
  const { dbx, db } = await seedBook();
  await postTrade(buy(), db, "t", TRADER);
  await postSafekeepingReconciliation(
    req({ intermediary_id: "interm_northgate", holdings: { sec_1: 29_000_000 } }), db, "t", CTX,
  );
  const ev = (dbx.rows["core.event"] ?? []).find((e) =>
    e.code === "safekeeping.reconciliation.completed"
  );
  assertEquals((ev!.payload as Any).breaks, 1);

  const s2 = await seedBook();
  await postTrade(buy(), s2.db, "t", TRADER);
  await postSafekeepingReconciliation(
    req({ intermediary_id: "interm_northgate", holdings: { sec_1: 30_000_000 } }), s2.db, "t", CTX,
  );
  const ev2 = (s2.dbx.rows["core.event"] ?? []).find((e) =>
    e.code === "safekeeping.reconciliation.completed"
  );
  assertEquals((ev2!.payload as Any).breaks, 0);
});

// -------------------------------------------------------- IP-07 concentration

Deno.test("IP-07: concentration is tested on the PROJECTED position", async () => {
  const { db } = await seedBook();
  await postTrade(buy({ par_cents: 300_000_000 }), db, "t", TRADER);
  // 300m held; another 100m would be 5333bp against a 5000bp limit
  const v = await evaluateTradeGate(db, "core", {
    security_id: "sec_1", instrument_class: "us_treasury", issuer_ref: "us_gov",
    intermediary_id: "interm_northgate", par_cents: 100_000_000, side: "buy",
    executed_by: "trader_1", maturity_months: 60,
  }, new Date());
  assertEquals(v.projected_par_cents, 400_000_000);
  assertEquals(v.limit, "breached");
});

Deno.test("IP-07: the warning fires on a trade that still EXECUTES", async () => {
  const { dbx, db } = await seedBook();
  const res = await postTrade(buy({ par_cents: 320_000_000 }), db, "t", TRADER);
  assertEquals(res.status, 201, "a warning must not block");
  assertEquals(dbx.rows["core.trade"][0].limit_verdict, "warning");
  assert(codes(dbx.rows).includes("trade.limit_warning.issued"));
  assert(!codes(dbx.rows).includes("trade.limit.blocked"));
});

Deno.test("IP-07: a breach blocks, books nothing, and opens a waiver", async () => {
  const { dbx, db } = await seedBook();
  const res = await postTrade(buy({ par_cents: 400_000_000 }), db, "t", TRADER);
  assertEquals(res.status, 409);
  assertEquals((dbx.rows["core.position"] ?? []).length, 0, "no position booked");
  assert(codes(dbx.rows).includes("concentration.limit_exceeded"));
  assert(codes(dbx.rows).includes("concentration.waiver.opened"));
});

Deno.test("IP-07: NO limit configured is unassessed, not within-limit", async () => {
  const { db } = await seedBook();
  const v = await evaluateTradeGate(db, "core", {
    security_id: "sec_2", instrument_class: "cmo", issuer_ref: "acme",
    intermediary_id: "interm_northgate", par_cents: 1, side: "buy", executed_by: "t",
  }, new Date());
  assertEquals(v.limit, "unassessed");
  assert(v.reasons.includes("no_issuer_limit_set"));
});

Deno.test("IP-07: a warning at or above the limit is refused as a limit definition", async () => {
  const { db } = await seedBook();
  const res = await putLimitSet(
    req({
      scope_kind: "issuer", scope_ref: "x", limit_bp_of_capital: 1000,
      warning_bp_of_capital: 1000, approved_by: "b",
    }),
    db, "t", CTX,
  );
  assertEquals(res.status, 400);
});

// --------------------------------------------------------- IP-11 checklist

Deno.test("IP-11: no pre-purchase checklist blocks the trade", async () => {
  const { dbx, db } = await seedBook();
  const res = await postTrade(buy({ checklist_completed: false }), db, "t", TRADER);
  assertEquals(res.status, 409);
  assert(codes(dbx.rows).includes("trade.checklist_exception_raised"));
});

// ---------------------------------------------------------------- IP-14 SoD

Deno.test("IP-14: the executing trader cannot confirm their own trade", async () => {
  const { dbx, db } = await seedBook();
  await postTrade(buy(), db, "t", TRADER);
  const tid = String(dbx.rows["core.trade"][0].id);
  const res = await postTradeConfirmation(
    req({ confirmed_by: "trader_1", counterparty_par_cents: 30_000_000 }), tid, db, "t", TRADER,
  );
  assertEquals(res.status, 409);
  assertEquals(dbx.rows["core.sod_violation"].length, 1);
  assert(codes(dbx.rows).includes("trade.sod.blocked"));
  assertEquals(dbx.rows["core.trade"][0].confirmed_by, null);
});

Deno.test("IP-14: the executing trader cannot settle their own trade either", async () => {
  const { dbx, db } = await seedBook();
  await postTrade(buy(), db, "t", TRADER);
  const tid = String(dbx.rows["core.trade"][0].id);
  await postTradeConfirmation(
    req({ confirmed_by: "ops_confirm", counterparty_par_cents: 30_000_000 }), tid, db, "t", CONFIRMER,
  );
  const res = await postTradeReconciliation(req({ settled_by: "trader_1" }), tid, db, "t", TRADER);
  assertEquals(res.status, 409);
  assertEquals(dbx.rows["core.trade"][0].reconciled_at, null);
});

Deno.test("IP-14: a confirmation that does not match the counterparty is flagged", async () => {
  const { dbx, db } = await seedBook();
  await postTrade(buy(), db, "t", TRADER);
  const tid = String(dbx.rows["core.trade"][0].id);
  await postTradeConfirmation(
    req({ confirmed_by: "ops_confirm", counterparty_par_cents: 29_000_000 }), tid, db, "t", CONFIRMER,
  );
  assertEquals(dbx.rows["core.trade"][0].confirmation_matched, false);
  assert(codes(dbx.rows).includes("trade.confirmation_discrepancy.flagged"));
  assert(!codes(dbx.rows).includes("trade.confirmation_matched"));
});

Deno.test("IP-14: a matching confirmation records the match", async () => {
  const { dbx, db } = await seedBook();
  await postTrade(buy(), db, "t", TRADER);
  const tid = String(dbx.rows["core.trade"][0].id);
  await postTradeConfirmation(
    req({ confirmed_by: "ops_confirm", counterparty_par_cents: 30_000_000 }), tid, db, "t", CONFIRMER,
  );
  assert(codes(dbx.rows).includes("trade.confirmation_matched"));
  assertEquals(dbx.violations, []);
});

Deno.test("IP-02: a trade exception cannot be self-approved", async () => {
  const { db } = await seedBook();
  const res = await postTradeException(
    req({ kind: "waiver", detail: {}, raised_by: "trader_1", approved_by: "trader_1" }),
    db, "t", CTX,
  );
  assertEquals(res.status, 409);
});

// --------------------------------------------------------------- IP-09 repo

Deno.test("IP-09: a margin shortfall ISSUES A CALL, not just a measurement", async () => {
  const { dbx, db } = await seedBook();
  await postRepoAgreement(
    req({
      intermediary_id: "interm_northgate", direction: "reverse_repo",
      principal_cents: 10_000_000, collateral_value_cents: 10_100_000,
      required_margin_bp: 200,
    }),
    db, "t", CTX,
  );
  assertEquals(dbx.rows["core.repo_agreement"][0].actual_margin_bp, 100);
  assert(codes(dbx.rows).includes("repo.margin_shortfall.detected"));
  assert(codes(dbx.rows).includes("repo.margin_call.issued"));
  assert(dbx.rows["core.repo_agreement"][0].margin_call_issued_at);
});

Deno.test("IP-09: adequate margin issues no call", async () => {
  const { dbx, db } = await seedBook();
  await postRepoAgreement(
    req({
      intermediary_id: "interm_northgate", direction: "repo",
      principal_cents: 10_000_000, collateral_value_cents: 10_500_000,
      required_margin_bp: 200,
    }),
    db, "t", CTX,
  );
  assert(!codes(dbx.rows).includes("repo.margin_call.issued"));
});

Deno.test("IP-09: an UNAPPROVED counterparty blocks the repo, not just a missing one", async () => {
  const { dbx, db } = await seedBook();
  // no counterparty at all
  assertEquals(
    (await postRepoAgreement(
      req({
        direction: "repo", principal_cents: 1_000_000,
        collateral_value_cents: 1_100_000, required_margin_bp: 200,
      }),
      db, "t", CTX,
    )).status,
    409,
  );
  // a counterparty that EXISTS but is not approved. The first version of this
  // test only covered the missing case, so a mutation removing the approval
  // check survived — the branch was never exercised.
  await postIntermediary(
    req({ name: "Backstreet", kind: "broker_dealer", regulator: "none", registration_status: "active" }),
    db, "t", CTX,
  );
  const res = await postRepoAgreement(
    req({
      intermediary_id: "interm_backstreet", direction: "repo", principal_cents: 1_000_000,
      collateral_value_cents: 1_100_000, required_margin_bp: 200,
    }),
    db, "t", CTX,
  );
  assertEquals(res.status, 409);
  const blocked = dbx.rows["core.repo_agreement"].filter((r) => r.decision === "blocked");
  assertEquals(blocked.length, 2);
  assertEquals(blocked[1].blocked_reason, "intermediary_not_approved");
  assert(codes(dbx.rows).includes("repo.blocked_rule_violation"));
});

// ---------------------------------------------------------- IP-10 valuation

Deno.test("IP-10: a fair value with no source is refused", async () => {
  const { db } = await seedBook();
  assertEquals(
    (await postFairValue(req({ fair_value_cents: 1 }), "sec_1", db, "t", CTX)).status, 400,
  );
});

Deno.test("IP-10: fair value below cost recognises an impairment; above it does not", async () => {
  const { dbx, db } = await seedBook();
  await postFairValue(
    req({ fair_value_cents: 28_000_000, source: "level_1", amortized_cost_cents: 30_000_000 }),
    "sec_1", db, "t", CTX,
  );
  const ev = (dbx.rows["core.event"] ?? []).find((e) =>
    e.code === "security.otti_analysis.completed"
  );
  assertEquals((ev!.payload as Any).impairment_cents, 2_000_000);

  const s2 = await seedBook();
  await postFairValue(
    req({ fair_value_cents: 31_000_000, source: "level_1", amortized_cost_cents: 30_000_000 }),
    "sec_1", s2.db, "t", CTX,
  );
  const ev2 = (s2.dbx.rows["core.event"] ?? []).find((e) =>
    e.code === "security.otti_analysis.completed"
  );
  assertEquals((ev2!.payload as Any).conclusion, "no_impairment");
});

Deno.test("IP-05: a downgrade with no review leaves the review absent, and it is visible", async () => {
  const { dbx, db } = await seedBook();
  await postSecurityDowngrade(req({ new_rating: "BB" }), "sec_1", db, "t", CTX);
  assert(dbx.rows["core.security"][0].downgraded_at);
  assertEquals(dbx.rows["core.security"][0].downgrade_reviewed_at, null);
  assert(codes(dbx.rows).includes("security.downgraded"));
  assert(!codes(dbx.rows).includes("security.downgrade.reviewed"));
  assertEquals(dbx.violations, []);
});

Deno.test("IP-05: a sub-investment-grade downgrade goes to the Board", async () => {
  const { dbx, db } = await seedBook();
  await postSecurityDowngrade(req({ new_rating: "BB", reviewed_by: "cio" }), "sec_1", db, "t", CTX);
  assert(codes(dbx.rows).includes("board.notification.sent"));

  const s2 = await seedBook();
  await postSecurityDowngrade(req({ new_rating: "AA", reviewed_by: "cio" }), "sec_1", s2.db, "t", CTX);
  assert(!codes(s2.dbx.rows).includes("board.notification.sent"));
});

Deno.test("IP-05: a credit file with no internal analysis is refused", async () => {
  const { db } = await seedBook();
  assertEquals(
    (await postCreditFile(req({ issuer_ref: "acme", external_rating: "A" }), db, "t", CTX)).status,
    400,
  );
});

// ------------------------------------------------------ IP-06 / IP-17 liquidity

Deno.test("IP-06: the liquidity report is computed from the book, not supplied", async () => {
  const { dbx, db } = await seedBook();
  await postTrade(buy(), db, "t", TRADER);
  await postLiquidityClassification(
    req({ security_id: "sec_1", liquidity_class: "level_1" }), db, "t", CTX,
  );
  await postLiquidityReport(
    req({ period: "2026Q3", min_marketable_bp: 5000, level_1_cents: 999 }), db, "t", CTX,
  );
  const r = dbx.rows["core.liquidity_report"][0];
  assertEquals(r.level_1_cents, 30_000_000);
  assertEquals(r.marketable_pct_bp, 10000);
  assertEquals(r.breached, false);
});

Deno.test("IP-06: an unset minimum yields no breach verdict", async () => {
  const { dbx, db } = await seedBook();
  await postLiquidityReport(req({ period: "2026Q3" }), db, "t", CTX);
  assertEquals(dbx.rows["core.liquidity_report"][0].breached, null);
});

Deno.test("IP-17: a contingency level cannot be activated without its execution plan", async () => {
  const { dbx, db } = await seedBook();
  assertEquals(
    (await postCfpLevelChange(req({ level: "stress", changed_by: "alco" }), db, "t", CTX)).status,
    400,
  );
  assertEquals(
    (await postCfpLevelChange(
      req({ level: "stress", changed_by: "alco", execution_plan_ref: "p1" }), db, "t", CTX,
    )).status,
    201,
  );
  assert(codes(dbx.rows).includes("liquidity.cfp.activated"));
  assertEquals(dbx.violations, []);
});

// ----------------------------------------------------- IP-04 / IP-13 analysis

Deno.test("IP-04: a simulation breach escalates; one within the minimum does not", async () => {
  const { dbx, db } = await seedBook();
  await postAlmSimulation(
    req({ kind: "irr", period: "q", scenario: "+300bp", result_bp: 400, minimum_bp: 600 }),
    db, "t", CTX,
  );
  assert(codes(dbx.rows).includes("stress_test.minimum.breached"));
  assert(codes(dbx.rows).includes("stress_test.remediation.escalated"));

  const s2 = await seedBook();
  await postAlmSimulation(
    req({ kind: "irr", period: "q", scenario: "+300bp", result_bp: 800, minimum_bp: 600 }),
    s2.db, "t", CTX,
  );
  assert(!codes(s2.dbx.rows).includes("stress_test.minimum.breached"));
  assertEquals(s2.dbx.violations, []);
});

Deno.test("IP-13: a return with no benchmark is refused", async () => {
  const { db } = await seedBook();
  assertEquals(
    (await postPerformanceMeasurement(
      req({ period: "q", portfolio_return_bp: 420 }), db, "t", CTX,
    )).status,
    400,
  );
});

// ------------------------------------------------------------- IP-15 records

Deno.test("IP-15: executing a trade declares the required document set with its clock", async () => {
  const { dbx, db } = await seedBook();
  await postTrade(buy(), db, "t", TRADER);
  const docs = dbx.rows["core.document"];
  assertEquals(docs.length, REQUIRED_TRADE_DOCUMENTS.length);
  assert(docs.every((d) => d.attachment_due_at));
  assert(codes(dbx.rows).includes("document.required_set"));
});

Deno.test("a blocked trade declares NO document set and books no position", async () => {
  const { dbx, db } = await seedBook();
  await postTrade(buy({ instrument_class: "cmo", security_id: "sec_2", issuer_ref: "acme" }), db, "t", TRADER);
  assertEquals((dbx.rows["core.document"] ?? []).length, 0);
  assertEquals((dbx.rows["core.position"] ?? []).length, 0);
});
