// Capital adequacy — the PCA bands, CP-03's unassessed trigger, the 45-day
// NWRP clock, CP-01 targets, and BA-04's RWA mapping.
//
// The negatives: a trigger nobody configured must report NO verdict rather
// than "not breached", a target at the floor is a plan to be undercapitalized,
// an unmapped exposure class must never weight to zero, and the NWRP cannot be
// filed for an institution that does not owe one.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { makeDrillDb } from "../drill/fake_db.ts";
import { OPS_CTX, req } from "./test_helpers.ts";
import { type PartnerContext } from "./auth.ts";
import {
  classifyPca, netWorthRatioBp, postCapitalDocument, postCapitalPosition, postCapitalSweep,
  postCapitalTarget, postNwrp, postRwaRun, TRADING_BOOK_THRESHOLD_CENTS,
} from "./capital.ts";

// deno-lint-ignore no-explicit-any
type Any = any;
const CTX = OPS_CTX;
/** CP-03: targets are write-restricted to the CCO. */
const CCO_CTX: PartnerContext = { ...OPS_CTX, tokenId: "tok_cco", roles: ["cco"] };
/** a second CCO-capable credential: four eyes is two tokens, not two names */
const APPROVER_CTX: PartnerContext = { ...OPS_CTX, tokenId: "tok_cco_2", roles: ["cco"] };
const codes = (rows: Record<string, Any[]>) =>
  (rows["core.event"] ?? []).map((e) => String(e.code));

const position = (o: Record<string, unknown> = {}) => req({
  as_of_date: "2026-03-31", net_worth_cents: 750_000_000,
  total_assets_cents: 5_000_000_000, ...o,
});

// -------------------------------------------------------------- PCA bands

Deno.test("the ratio is FLOORED and classifies at the statutory boundaries", () => {
  // flooring never rounds an institution up into a better band
  assertEquals(netWorthRatioBp(699_999_999, 10_000_000_000), 699);
  assertEquals(classifyPca(700), "well_capitalized");
  assertEquals(classifyPca(699), "adequately_capitalized");
  assertEquals(classifyPca(599), "undercapitalized");
  assertEquals(classifyPca(399), "significantly_undercapitalized");
  assertEquals(classifyPca(199), "critically_undercapitalized");
});

Deno.test("a well-capitalized position is recorded unrestricted, ratio derived from components", async () => {
  const dbx = makeDrillDb();
  const res = await postCapitalPosition(position(), dbx.client, "t", CTX);
  assertEquals(res.status, 201);
  const row = dbx.rows["core.capital_position"][0];
  assertEquals(row.net_worth_ratio_bp, 1500);
  assertEquals(row.pca_category, "well_capitalized");
  assertEquals(row.distribution_restricted, false);
  assertEquals(row.nwrp_due_at, null);
  const c = codes(dbx.rows);
  assert(c.includes("capital.ratios.verified"));
  assert(!c.includes("capital.pca_threshold.breached"));
  // the fake enforces ck_capital_ratio_matches_components — a stored ratio
  // that disagreed with its own inputs would land here
  assertEquals(dbx.violations, []);
});

// ------------------------------------------------------------------ CP-03

Deno.test("CP-03: an unset internal trigger reports NO verdict, not 'not breached'", async () => {
  const dbx = makeDrillDb();
  await postCapitalPosition(position(), dbx.client, "t", CTX);
  // "nobody configured a trigger" and "the trigger was not breached" are
  // opposite facts about the institution
  assertEquals(dbx.rows["core.capital_position"][0].internal_trigger_breached, null);
  assert(!codes(dbx.rows).includes("capital.internal_trigger.breached"));
  assertEquals(dbx.violations, []);
});

Deno.test("CP-03/CP-08: a breached internal trigger escalates under BOTH alias codes", async () => {
  const dbx = makeDrillDb();
  await postCapitalPosition(position({ internal_trigger_bp: 1600 }), dbx.client, "t", CTX);
  assertEquals(dbx.rows["core.capital_position"][0].internal_trigger_breached, true);
  const c = codes(dbx.rows);
  assert(c.includes("capital.internal_trigger.breached"));
  // the corpus names the board-escalation fact two ways; both must exist
  assert(c.includes("capital.board_escalation"));
  assert(c.includes("capital.board_escalation.issued"));
});

// ---------------------------------------------------------- CP-04 / NWRP

Deno.test("CP-04: above the floor but through the buffer is its own breach", async () => {
  const dbx = makeDrillDb();
  // 650bp: adequately capitalized (no PCA restriction), buffer breached
  await postCapitalPosition(
    position({ net_worth_cents: 325_000_000 }), dbx.client, "t", CTX,
  );
  const row = dbx.rows["core.capital_position"][0];
  assertEquals(row.pca_category, "adequately_capitalized");
  assertEquals(row.distribution_restricted, false);
  const c = codes(dbx.rows);
  assert(c.includes("capital.buffer.breached"));
  assert(!c.includes("capital.pca_threshold.breached"));
});

Deno.test("an undercapitalized position restricts payouts and starts the 45-day NWRP clock", async () => {
  const dbx = makeDrillDb();
  // 500bp -> undercapitalized
  await postCapitalPosition(
    position({ net_worth_cents: 250_000_000 }), dbx.client, "t", CTX,
  );
  const row = dbx.rows["core.capital_position"][0];
  assertEquals(row.pca_category, "undercapitalized");
  assertEquals(row.distribution_restricted, true);
  const days = Math.round((new Date(String(row.nwrp_due_at)).getTime() - Date.now()) / 86_400_000);
  assertEquals(days, 45, "the clock anchors on the CLASSIFICATION");
  const c = codes(dbx.rows);
  assert(c.includes("capital.pca_threshold.breached"));
  assert(c.includes("capital.distribution_restriction.applied"));
  assert(c.includes("capital.payout_restricted"));
  assertEquals(dbx.violations, []);

  // filing the plan is only possible BECAUSE one is due
  const filed = await postNwrp(req({ filed_by: "cfo_1" }), String(row.id), dbx.client, "t", CTX);
  assertEquals(filed.status, 200);
  assert(codes(dbx.rows).includes("capital.restoration_plan.filed"));

  // and a healthy institution cannot file one at all
  const dbx2 = makeDrillDb();
  await postCapitalPosition(position(), dbx2.client, "t", CTX);
  const denied = await postNwrp(
    req({ filed_by: "cfo_1" }), String(dbx2.rows["core.capital_position"][0].id),
    dbx2.client, "t", CTX,
  );
  assertEquals(denied.status, 409);
});

// ------------------------------------------------------------ CP-01 targets

Deno.test("CP-01: a target at or below the 700bp floor is refused", async () => {
  const dbx = makeDrillDb();
  const res = await postCapitalTarget(
    req({ effective_date: "2026-07-01", target_bp: 650, proposed_by: "cco_1" }),
    dbx.client, "t", CCO_CTX,
  );
  // a "target" below the floor is a plan to be undercapitalized
  assertEquals(res.status, 409);
  assertEquals((dbx.rows["core.capital_target"] ?? []).length, 0);
});

Deno.test("CP-03: targets are CCO-restricted and cannot be self-approved", async () => {
  const dbx = makeDrillDb();
  const noRole = await postCapitalTarget(
    req({ effective_date: "2026-07-01", target_bp: 900, proposed_by: "cco_1" }),
    dbx.client, "t", CTX,
  );
  assertEquals(noRole.status, 403);

  const selfApproved = await postCapitalTarget(
    req({ effective_date: "2026-07-01", target_bp: 900, proposed_by: "cco_1", approved_by: "cco_1" }),
    dbx.client, "t", CCO_CTX,
  );
  assertEquals(selfApproved.status, 409);

  // one token filing the target together with an approver it names is still
  // one credential: four eyes binds to the CALLER, not to the body's names
  const oneToken = await postCapitalTarget(
    req({ effective_date: "2026-07-01", target_bp: 900, proposed_by: "cco_1", approved_by: "board_1" }),
    dbx.client, "t", CCO_CTX,
  );
  assertEquals(oneToken.status, 409);
  assert(!codes(dbx.rows).includes("capital.targets.approved"));

  const proposed = await postCapitalTarget(
    req({ effective_date: "2026-07-01", target_bp: 900, proposed_by: "cco_1" }),
    dbx.client, "t", CCO_CTX,
  );
  assertEquals(proposed.status, 201);
  // the proposer's own token cannot then approve it
  const selfToken = await postCapitalTarget(
    req({ effective_date: "2026-07-01", target_bp: 900, proposed_by: "cco_1", approved_by: "board_1" }),
    dbx.client, "t", CCO_CTX,
  );
  assertEquals(selfToken.status, 409);
  const ok = await postCapitalTarget(
    req({ effective_date: "2026-07-01", target_bp: 900, proposed_by: "cco_1", approved_by: "board_1" }),
    dbx.client, "t", APPROVER_CTX,
  );
  assertEquals(ok.status, 201);
  const row = dbx.rows["core.capital_target"][0];
  assertEquals(row.proposed_by_token, "tok_cco");
  assertEquals(row.approved_by_token, "tok_cco_2");
  assert(codes(dbx.rows).includes("capital.targets.approved"));
});

Deno.test("an insolvent position records the ratio the DB constraint computes (truncated toward zero)", async () => {
  // -2.47bp: Postgres bigint division gives -2; flooring to -3 was a 500
  assertEquals(netWorthRatioBp(-2_469_135, 10_000_000_000), -2);
  const dbx = makeDrillDb();
  const res = await postCapitalPosition(
    position({ net_worth_cents: -2_469_135, total_assets_cents: 10_000_000_000 }), dbx.client, "t", CTX,
  );
  assertEquals(res.status, 201);
  assertEquals(dbx.rows["core.capital_position"][0].pca_category, "critically_undercapitalized");
  assertEquals(dbx.violations, []);
});

Deno.test("a restatement of a still-undercapitalized quarter keeps the first NWRP deadline", async () => {
  const dbx = makeDrillDb();
  await postCapitalPosition(position({ net_worth_cents: 250_000_000 }), dbx.client, "t", CTX);
  const first = dbx.rows["core.capital_position"][0].nwrp_due_at;
  assert(first);
  await new Promise((r) => setTimeout(r, 5));
  await postCapitalPosition(position({ net_worth_cents: 260_000_000 }), dbx.client, "t", CTX);
  assertEquals(dbx.rows["core.capital_position"][0].nwrp_due_at, first);
});

Deno.test("CP-05: only a cfo token files the capital plan", async () => {
  const dbx = makeDrillDb();
  const denied = await postCapitalDocument(
    req({ kind: "capital_plan", cycle: "2026Q2", prepared_by: "x" }), dbx.client, "t", CTX,
  );
  assertEquals(denied.status, 403);
  assertEquals((dbx.rows["core.capital_document"] ?? []).length, 0);
  const ok = await postCapitalDocument(
    req({ kind: "capital_plan", cycle: "2026Q2", prepared_by: "x" }), dbx.client, "t",
    { ...OPS_CTX, tokenId: "tok_cfo", roles: ["cfo"] },
  );
  assertEquals(ok.status, 201);
});

// ------------------------------------------------------------------ BA-04

Deno.test("BA-04: an unmapped exposure class is SURFACED, never weighted at zero", async () => {
  const dbx = makeDrillDb();
  await postCapitalPosition(position(), dbx.client, "t", CTX);
  const id = String(dbx.rows["core.capital_position"][0].id);
  const res = await postRwaRun(
    req({
      exposures: [
        { class: "consumer", amount_cents: 1_000_000 }, // 100% -> 1,000,000
        { class: "gse", amount_cents: 1_000_000 }, //       20% ->   200,000
        { class: "crypto", amount_cents: 5_000_000 }, // no published weight
      ],
      trading_book_cents: TRADING_BOOK_THRESHOLD_CENTS,
    }),
    id, dbx.client, "t", CTX,
  );
  const body = (await res.json()).data;
  assertEquals(body.risk_weighted_assets_cents, 1_200_000);
  // dropping OR zero-weighting the unknown class would understate RWA — the
  // direction that flatters the institution
  assertEquals(body.unmapped_exposure_classes, ["crypto"]);
  assertEquals(body.rwa_complete, false);
  assertEquals(body.trading_threshold_crossed, true);
  assert(codes(dbx.rows).includes("rwa.trading_threshold_crossed"));
});

// ------------------------------------------------------------------ sweep

Deno.test("the sweep escalates an overdue NWRP and reports the unassessed separately", async () => {
  const dbx = makeDrillDb();
  dbx.rows["core.capital_position"] = [{
    id: "cap_20260331", as_of_date: "2026-03-31", net_worth_cents: 250_000_000,
    total_assets_cents: 5_000_000_000, net_worth_ratio_bp: 500,
    pca_category: "undercapitalized", internal_trigger_bp: null,
    internal_trigger_breached: null, nwrp_due_at: "2026-05-15T00:00:00.000Z",
    nwrp_filed_at: null, distribution_restricted: true, provenance: "production",
  }];
  const res = await postCapitalSweep(req({}), dbx.client, "t", CTX);
  const body = (await res.json()).data;
  assertEquals(body.nwrp_overdue, 1);
  // a clean overdue count must not read as a clean bill of health when the
  // book was never assessed against an internal trigger
  assertEquals(body.unassessed_internal_trigger, 1);
  assert(body.note);
  assert(codes(dbx.rows).includes("capital.board_escalation"));
  assert(codes(dbx.rows).includes("capital.quarterly_report.issued"));
});
