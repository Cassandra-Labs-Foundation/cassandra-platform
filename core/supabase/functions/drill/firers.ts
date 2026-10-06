// What the core can actually be made to DO, per trigger event.
//
// Every control in controls.json declares `trigger_event` -> `produced_events`.
// That IS its specification, so the test for every control is uniform:
//
//     fire the trigger through the API, then assert the produced events appear
//
// A control whose subsystem does not exist has no firer, its test goes RED, and
// the red line names the trigger that needs a writer. Red is the backlog.

// deno-lint-ignore no-explicit-any
type Any = any;

import { postAccountTransition } from "../api/accounts.ts";
import { postEntity, postEntityTransition } from "../api/entities.ts";
import { postVerification } from "../api/kyc.ts";
import { postAlertTriage, postCaseDecision, raiseAlert } from "../api/bsa.ts";
import { postCashTransaction, postCtrFile } from "../api/cash.ts";
import { postDisposalSweep, postDisposeRecord, postLegalHold, postHoldRelease, setRetentionClocks } from "../api/retention.ts";
import { postCalendarSweep, postObligation } from "../api/governance.ts";
import { postAanIssue, postLoanDecision, postLoanParty } from "../api/lending.ts";
import { openApproval, postPaymentApproval, putClientLimit, wireDualControl } from "../api/eps.ts";
import { postAttestation, postObservation, postWorkItem, postWorkItemClose, postWorkItemSweep, putThreshold } from "../api/primitives.ts";
import { postAch } from "../api/ach.ts";
import { postWirePrepare } from "../api/wires.ts";
import { postTransfer } from "../api/transfers.ts";
import {
  postCloseIncident, postContainIncident, postDetermineReportability, postExternalComms,
  postFirstHour, postIncidentAssessment,
  postIncident, postIncidentSweep, postMemberImpact, postNotifyNcua,
} from "../api/incidents.ts";

// Realistic display names for drill-generated person fixtures. Picked by the
// run counter so a run spreads across the roster instead of stamping "Drill
// <n>"; the entity id — not the name — is the unique key, so shared names are
// fine. Holds no "SDN" token, which the OFAC screen keys on (kyc.ts).
const DRILL_PERSONAS = [
  "Elena Marsh", "James Okafor", "Diego Ramirez", "Sofia Bennett", "Aisha Khan", "Maya Patel",
  "Lucas Romano", "Chloe Nguyen", "Isaac Adeyemi", "Nora Sullivan", "Gabriel Costa", "Hannah Weiss",
  "Omar Haddad", "Ava Lindqvist", "Julian Torres", "Zoe Callahan", "Ruth Mensah", "Caleb Fry",
  "Leila Haddad", "Theo Vance", "Mira Kapoor", "Owen Slater", "Farah Aziz", "Daniel Cho",
];
const drillPersona = (n: number): string => DRILL_PERSONAS[Math.abs(n) % DRILL_PERSONAS.length];

/**
 * The whole incident lifecycle, driven end to end.
 *
 * declare -> first hour + sitrep -> reportability determination (Compliance
 * only) -> NCUA notification within 72h OF THE DETERMINATION -> member notices
 * -> contain -> close -> sweep. Nothing is handed a code to emit.
 */
async function runEpsAuthFraud(env: FireEnv): Promise<void> {
  // OQ-24: issue a real card first. EPS-05 and EPS-07 declare card.id and
  // card.spend_controls as required inputs, and before the issuance writer
  // existed no card row could be created, so both stayed red on a missing
  // NOUN rather than any fault in their own logic.
  await postIssueCard(
    R({ member_ref: "mbr_eps_1", spend_controls: "intl_blocked" }),
    env.db, "d", env.actors.ops,
  );

  // Three failures in a row must LOCK OUT on the third, in the same write.
  for (let i = 0; i < 3; i++) {
    await postAuthEvent(
      R({ subject_ref: "mbr_eps_1", channel: "online", outcome: "failure" }),
      env.db, "d", env.actors.ops,
    );
  }
  // A challenged (not denied) attempt, which must carry its method. The
  // subject is run-unique: failure_count carries across runs on the live
  // tier (prior = max failure_count for the subject), so a fixed subject
  // walks itself over the lockout threshold and the challenge becomes a
  // lockout (EPS-05's fake-vs-real defect).
  const mbrCh = `mbr_eps_ch_${env.n()}`;
  await postAuthEvent(
    R({ subject_ref: mbrCh, channel: "mobile", outcome: "failure", challenge_method: "otp_sms" }),
    env.db, "d", env.actors.ops,
  );
  await postAuthEvent(
    R({ subject_ref: mbrCh, channel: "mobile", outcome: "success" }),
    env.db, "d", env.actors.ops,
  );

  // First application has no previous value, so `changed` must NOT be emitted;
  // the second one must.
  await postCardControl(
    R({ card_ref: "card_1", control_type: "intl_block", new_value: "on", applied_by: "ops_1" }),
    env.db, "d", env.actors.ops,
  );
  await postCardControl(
    R({ card_ref: "card_1", control_type: "intl_block", new_value: "off", applied_by: "ops_1" }),
    env.db, "d", env.actors.ops,
  );

  await postPospayException(
    R({
      account_ref: "acct_pp", item_ref: "item_1", amount_cents: 250_00,
      reason: "amount_mismatch", cutoff_at: "2030-01-01T00:00:00.000Z",
    }),
    env.db, "d", env.actors.ops,
  );
  await postPospayDecision(
    R({ decision: "return", decided_by: "ops_2" }), "epspp_item_1", env.db, "d", env.actors.ops,
  );
  // NEGATIVE: an exception left undecided past its cutoff. It pays by default,
  // which is the risk the sweep exists to surface.
  await postPospayException(
    R({
      account_ref: "acct_pp", item_ref: "item_2", amount_cents: 900_00,
      reason: "no_issue_record", cutoff_at: "2020-01-01T00:00:00.000Z",
    }),
    env.db, "d", env.actors.ops,
  );
  await postFraudTrendReview(R({}), env.db, "d", env.actors.ops);
}

/**
 * The whole CDA programme, driven end to end.
 *
 * Board adoption -> qualified trustee -> segregated structure -> agreement
 * clauses A-D -> funding through the gate -> cap test -> a real cap BREACH
 * caused by net worth falling -> a cure that actually reduces the aggregate ->
 * distributions -> overlays and trades -> reconciliation -> quarter packet ->
 * programme audit -> termination. Nothing is handed a code to emit.
 *
 * Roughly half of the calls below are NEGATIVES that must be refused: an
 * unlabelled account, an agreement missing clause C, funding against an
 * unqualified vendor, a distribution to an unvalidated donee, a $60k
 * distribution self-approved by its proposer, a trade with no overlay
 * configured, an affiliate fee, a non-permissible in-kind asset. Each is
 * expected to 409, and each writes the refusal as evidence — a gate that only
 * records what it permitted cannot be audited.
 */
async function runCdaLifecycle(env: FireEnv): Promise<void> {
  // The harness fires every trigger a control declares, so a control with four
  // triggers would otherwise run this four times against the same ledger. The
  // lifecycle is a single narrative with a real cap breach and cure in it;
  // replaying it would re-supersede the policy adoption and block everything.
  if ((env.rows["core.cda"] ?? []).length > 0) return;

  const ops = env.actors.ops;
  const compliance = { ...ops, tokenId: "tok_cda_compliance", roles: ["bsa_compliance"] };

  // --- CDA-01: Board adoption. Everything else is gated on this being live.
  await postCdaPolicyAdoption(
    R({ policy_version: "v1.0", board_resolution_id: "board-2026-014", adopted_at: "2026-06-16T00:00:00.000Z" }),
    env.db, "d", compliance,
  );

  // net worth, from the capital subsystem rather than supplied: $7.5m of $50m
  await postCapitalPosition(
    R({ as_of_date: "2026-03-31", net_worth_cents: 750_000_000, total_assets_cents: 5_000_000_000 }),
    env.db, "d", ops,
  );
  // RESTORE the 2026-09-30 position before the arc begins. The breach step
  // below rewrites this same date-keyed row to $4m; on the live tier that end
  // state survives into the next run (and other lifecycles write the same
  // date), so without this restore the funding gate reads last run's shrunken
  // net worth and refuses the funding the whole CDA-06 arc depends on.
  await postCapitalPosition(
    R({ as_of_date: "2026-09-30", net_worth_cents: 750_000_000, total_assets_cents: 5_000_000_000 }),
    env.db, "d", ops,
  );

  // --- CDA-04: one qualified trustee, one that must NOT qualify.
  await postCdaVendor(
    R({
      name: "Northgate Trust", role: "trustee", regulator: "occ",
      registration_status: "active", registration_evidence_ref: "occ-cert-2026",
    }),
    env.db, "d", compliance,
  );
  // NEGATIVE: an adviser with no registration evidence. Qualification is
  // derived, so this cannot be waved through by asserting it.
  await postCdaVendor(
    R({ name: "Harbor Advisors", role: "discretionary_manager", regulator: "sec", registration_status: "active" }),
    env.db, "d", compliance,
  );
  // and a lapse detected on annual review, which must escalate to the Board
  await postCdaVendorReview(
    R({ registration_status: "lapsed" }), "cdaven_northgatetrust", env.db, "d", compliance,
  );
  // restore it, so the rest of the programme runs against a qualified trustee
  await postCdaVendorReview(
    R({ registration_status: "active", registration_evidence_ref: "occ-cert-2026" }),
    "cdaven_northgatetrust", env.db, "d", compliance,
  );

  // --- CDA-03: structure and segregation.
  await postCda(
    R({
      id: "cda_main", vendor_id: "cdaven_northgatetrust",
      structure_type: "segregated_custodial",
      account_label: "Pynthia Charitable Donation Account",
      custodian_statement_ref: "cust-stmt-2026Q2",
    }),
    env.db, "d", compliance,
  );
  // NEGATIVE: a CDA whose label does not designate it as one. §721.3(b)(2)(i)
  // requires the designation, not merely a name.
  await postCda(
    R({
      id: "cda_unlabelled", vendor_id: "cdaven_harboradvisors",
      structure_type: "spe_trust", account_label: "Investment Sub-Account",
    }),
    env.db, "d", compliance,
  );

  // --- CDA-05: clauses A-D.
  await postCdaAgreement(
    R({
      clauses: {
        agreement_named_charities_clause: true, agreement_strategy_clause: true,
        agreement_gaap_clause: true, agreement_distribution_clause: true,
      },
      strategy_limits: { max_duration_years: 5, min_rating: "investment_grade" },
      amendment: { agreement_redline: "redline-3", board_resolution_id: "board-2026-021" },
    }),
    "cda_main", env.db, "d", compliance,
  );
  // NEGATIVE: missing the GAAP clause.
  await postCdaAgreement(
    R({
      clauses: {
        agreement_named_charities_clause: true, agreement_strategy_clause: true,
        agreement_distribution_clause: true,
      },
    }),
    "cda_unlabelled", env.db, "d", compliance,
  );

  // --- CDA-06: funding through the gate. 5% of $7.5m is $375k; this is $250k.
  // book value accumulates run over run on the converged cda_main row
  // (funding is read-modify-write), so the arc's cap arithmetic only holds
  // if it starts from zero every run
  await env.db.schema("core").from("cda")
    .update({ book_value_cents: 0 }).eq("id", "cda_main");
  await postCdaFunding(R({ amount_cents: 25_000_000 }), "cda_main", env.db, "d", ops);
  // NEGATIVE: the unlabelled CDA fails four conditions at once, and the
  // refusal must name all of them rather than the first.
  await postCdaFunding(R({ amount_cents: 1_000_00 }), "cda_unlabelled", env.db, "d", ops);

  await postCdaCapTest(
    R({ as_of_date: "2026-06-30", certified_by: "controller_01" }), env.db, "d", compliance,
  );

  // --- CDA-06 breach: net worth FALLS to $4m. Nothing about the CDA changed;
  // the same $250k is now 6.25% of net worth. This is how cap breaches
  // actually happen, and it is why the cap test cannot be a funding-time check
  // alone.
  await postCapitalPosition(
    R({ as_of_date: "2026-09-30", net_worth_cents: 400_000_000, total_assets_cents: 5_000_000_000 }),
    env.db, "d", ops,
  );
  await postCdaCapTest(
    R({ as_of_date: "2026-09-30", certified_by: "controller_01" }), env.db, "d", compliance,
  );

  // --- CDA-08: the five-year window, opened with a real Total Return.
  // run-unique opened_at (the window id embeds its epoch): distributions
  // accumulate against a converged window until coverage passes and the
  // shortfall alert becomes unreachable (CDA-08/CDA-12's defect)
  const winOpenedMs = Date.UTC(2026, 0, 1) + (env.n() % 86_400_000);
  const winId = `cdawin_cda_main_${winOpenedMs}`;
  await postCdaDistributionWindow(
    R({
      opened_at: new Date(winOpenedMs).toISOString(), closes_at: "2031-01-01T00:00:00.000Z",
      total_return_cents: 20_000_000,
    }),
    "cda_main", env.db, "d", compliance,
  );

  // NEGATIVE: an unvalidated donee. No EIN, no IRS status.
  await postCdaDistribution(
    R({
      donee_name: "Unknown Foundation", amount_cents: 1_000_00,
      proposed_by: "ops_1", approved_by: "ops_2", window_id: winId,
    }),
    "cda_main", env.db, "d", ops,
  );
  // NEGATIVE: $60k self-approved. Two calls by one token is not two people.
  await postCdaDistribution(
    R({
      donee_name: "Riverside Food Bank", donee_ein: "12-3456789", donee_irs_status: "501c3",
      amount_cents: 6_000_000, proposed_by: "ops_1", approved_by: "ops_1",
    }),
    "cda_main", env.db, "d", ops,
  );
  // the real one, dual-approved. It also drops book value under the 5% cap.
  await postCdaDistribution(
    R({
      donee_name: "Riverside Food Bank", donee_ein: "12-3456789", donee_irs_status: "501c3",
      amount_cents: 6_000_000, proposed_by: "ops_1", approved_by: "ops_2",
      window_id: winId,
    }),
    "cda_main", env.db, "d", ops,
  );
  // a sub-threshold one, which is logged with SINGLE approval rather than
  // silently omitted
  await postCdaDistribution(
    R({
      donee_name: "Riverside Food Bank", donee_ein: "12-3456789", donee_irs_status: "501c3",
      amount_cents: 250_00, proposed_by: "ops_1",
      window_id: winId,
    }),
    "cda_main", env.db, "d", ops,
  );

  // --- CDA-06 cure: the aggregate is now genuinely back under 5%.
  await postCdaCapCure(
    R({ cure_plan: "distributed $60,250 to Riverside Food Bank" }),
    "cdacap_20260930", env.db, "d", compliance,
  );

  // --- CDA-07: Board overlays, then a clean trade and a concentrated one.
  await putCdaOverlay(
    R({ limit_bp: 2500, approved_by: "board-2026-014" }),
    "cda_main", "single_issuer", env.db, "d", compliance,
  );
  await postCdaTrade(
    R({ issuer: "US Treasury", sector: "sovereign", amount_cents: 2_000_000 }),
    "cda_main", env.db, "d", ops,
  );
  // NEGATIVE: 25%+ of the book in one issuer.
  await postCdaTrade(
    R({ issuer: "Single Corp", sector: "corporate", amount_cents: 20_000_000 }),
    "cda_main", env.db, "d", ops,
  );
  await postCdaPosttradeCheck(R({ period: "2026-09" }), "cda_main", env.db, "d", compliance);

  // --- CDA-09: reconciliation, then the 789H mapping that hangs off it.
  await postCdaReconciliation(
    R({ period: "2026-08", gl_balance_cents: 18_750_000, custodian_balance_cents: 18_750_000 }),
    "cda_main", env.db, "d", compliance,
  );
  // NEGATIVE: books that do not agree.
  await postCdaReconciliation(
    R({ period: "2026-09", gl_balance_cents: 18_750_000, custodian_balance_cents: 18_749_100 }),
    "cda_main", env.db, "d", compliance,
  );
  await postCdaCallReportMapping(
    R({ cycle: "2026Q3", account_789h_mapping: "789H" }), "cda_main", env.db, "d", compliance,
  );

  // --- CDA-13: a permitted fee and an affiliate one that must be refused.
  await postCdaFeePayment(
    R({ payee: "Northgate Trust", amount_cents: 12_500 }), "cda_main", env.db, "d", ops,
  );
  await postCdaFeePayment(
    R({ payee: "Pynthia Credit Union", amount_cents: 40_000 }), "cda_main", env.db, "d", ops,
  );

  // --- CDA-11: quarterly valuation review on independent pricing.
  await postCdaValuationReview(
    R({
      period: "2026Q3", independent_pricing_ref: "bloomberg-2026Q3",
      portfolio_composition: { us_treasury: 2_000_000 },
    }),
    "cda_main", env.db, "d", compliance,
  );

  // --- CDA-01 / CDA-09 / CDA-13: the quarterly packet, assembled from the
  // tables rather than from a supplied summary.
  await postCdaQuarterClose(
    R({ quarter: "2026Q3", preparer_id: "controller_01" }), env.db, "d", compliance,
  );

  // --- CDA-11: the annual programme audit and its remediation.
  await postCdaAuditCycle(
    R({
      cycle_year: 2026,
      findings: [{ summary: "cap test evidence not retained", remediation_owner: "controller_01", due_days: 60 }],
    }),
    env.db, "d", compliance,
  );
  await postCdaFindingClose(
    R({ closure_evidence_ref: "remediation-pack-2026-1" }), "cdafind_2026_0", env.db, "d", compliance,
  );

  // --- CDA-02: a glossary change, versioned against the prior active term.
  await postCdaGlossaryChange(
    R({
      term: "Total Return", definition: "income plus realised and unrealised gains",
      citation: "12 CFR 721.3(b)(2)", attested_by: "compliance_01",
    }),
    env.db, "d", compliance,
  );

  // --- CDA-14: draft, approve, publish; and a page that fails the checklist.
  await postCdaCommunication(
    R({ title: "CDA Program", draft_ref: "draft-cda-1" }), env.db, "d", compliance,
  );
  // NEGATIVE: Marketing approval alone, with a failing WCAG checklist.
  await postCdaCommunicationApproval(
    R({ wcag_checklist_passed: false, marketing_approved_by: "mktg_01" }),
    "cdacom_cdaprogram", env.db, "d", compliance,
  );
  await postCdaCommunicationApproval(
    R({
      wcag_checklist_passed: true, marketing_approved_by: "mktg_01",
      compliance_approved_by: "compliance_01",
    }),
    "cdacom_cdaprogram", env.db, "d", compliance,
  );
  await postCdaCommunicationPublish(
    R({ archived_ref: "archive-cda-1" }), "cdacom_cdaprogram", env.db, "d", compliance,
  );

  // --- CDA-12: termination, closing distribution, in-kind, close.
  await postCdaTermination(
    R({ approved_by: "board-2026-031", final_accounting_ref: "final-2026" }),
    "cda_main", env.db, "d", compliance,
  );
  // the >=51% closing distribution: 20% was distributed in-window, so this
  // takes cumulative coverage over the threshold
  await postCdaDistribution(
    R({
      donee_name: "Riverside Food Bank", donee_ein: "12-3456789", donee_irs_status: "501c3",
      amount_cents: 4_500_000, kind: "closing", proposed_by: "ops_1", approved_by: "ops_2",
      window_id: winId,
    }),
    "cda_main", env.db, "d", ops,
  );
  await postCdaInkindTransfer(
    R({ asset_class: "us_treasury", amount_cents: 1_000_000, determination_ref: "part703-det-1" }),
    "cda_main", env.db, "d", compliance,
  );
  // NEGATIVE: an asset with no Part 703 basis must be liquidated, not received.
  await postCdaInkindTransfer(
    R({ asset_class: "private_equity_fund", amount_cents: 500_000, determination_ref: "part703-det-2" }),
    "cda_main", env.db, "d", compliance,
  );
  await postCdaClose(
    R({ final_accounting_ref: "final-accounting-2026" }), "cda_main", env.db, "d", compliance,
  );

  // --- CDA-01's negative half: let the adoption lapse and confirm the sweep
  // blocks the programme. Done LAST because it blocks everything above it.
  // through the client: mutating the recorded copy leaves the live row
  // unexpired and the sweep finds nothing to block (CDA-01's defect)
  // expired = in the past but AFTER the fixed 2026-06-16 adoption, or
  // ck_cda_policy_expiry_after_adoption refuses the backdate outright
  await env.db.schema("core").from("cda_policy")
    .update({ policy_expiry_at: "2026-07-01T00:00:00.000Z" }).eq("id", "cdapol_v10");
  await postCdaPolicySweep(R({}), env.db, "d", compliance);
  // and a funding attempt against an expired policy, which must be refused
  await postCdaFunding(R({ amount_cents: 1_000_00 }), "cda_main", env.db, "d", ops);
}

/**
 * The whole cash-OPERATIONS programme, driven end to end.
 *
 * Board policy -> vault and ATM registered -> effective-dated limits -> a
 * permitted load and a refused one -> enterprise position through warning and
 * breach and a real remediation -> reconciliation with a variance that parks
 * in GL suspense and ages -> over/short with a cumulative pattern that raises
 * a BSA alert -> shipments with a matched seal and a mismatched one that
 * declares an incident -> CMIR on a border crossing -> surprise count ->
 * seasonal deviation -> KRI pack -> Board summary -> examiner export.
 *
 * WHAT IS ABSENT ON PURPOSE: no employee is created and no HR record is
 * written. CP-05 and CP-07 stay red naming those entities. See the standing
 * rule in BLUEPRINT.
 */
async function runCashOpsLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.cash_asset"] ?? []).length > 0) return;

  const ops = env.actors.ops;
  // HR basics: CP-07 needs a coachable employee; CP-12 computes training
  // coverage over declared cash-handlers — both are personnel FACTS, declared
  await postEmployee(R({ id: "emp_t1", name: "Teller One", role: "teller", cash_handler: true }), env.db, "d", ops);
  await postEmployee(R({ id: "emp_t2", name: "Teller Two", role: "teller", cash_handler: true }), env.db, "d", ops);
  await postEmployeeTraining(R({ course: "cash_handling" }), "emp_t1", env.db, "d", ops);
  const compliance = { ...ops, tokenId: "tok_cash_compliance", roles: ["bsa_compliance"] };

  await postCashPolicyAdoption(
    R({
      policy_document_version: "cash-v2.1", board_resolution_id: "board-2026-007",
      adopted_at: "2026-04-01T00:00:00.000Z",
    }),
    env.db, "d", compliance,
  );

  await putCashAsset(
    R({ asset_type: "vault", location_id: "branch_01", balance_cents: 500_000_00,
        custodian_user_id: "cust_1" }),
    "casset_vault1", env.db, "d", ops,
  );
  await putCashAsset(
    R({ asset_type: "atm", location_id: "branch_01", balance_cents: 40_000_00,
        custodian_user_id: "cust_2" }),
    "casset_atm1", env.db, "d", ops,
  );
  // an asset with NO limits schedule at all, so a load against it must be
  // refused for "unknown", not permitted for "no limit"
  await putCashAsset(
    R({ asset_type: "teller_drawer", location_id: "branch_02", balance_cents: 5_000_00 }),
    "casset_drawer_unlimited", env.db, "d", ops,
  );

  await postCashLimitsSchedule(
    R({ asset_id: "casset_vault1", limit_cents: 750_000_00,
        effective_at: "2026-01-01T00:00:00.000Z", board_resolution_id: "board-2026-007" }),
    env.db, "d", compliance,
  );
  await postCashLimitsSchedule(
    R({ asset_id: "casset_atm1", limit_cents: 60_000_00,
        effective_at: "2026-01-01T00:00:00.000Z", board_resolution_id: "board-2026-007" }),
    env.db, "d", compliance,
  );
  // NEGATIVE for the ordering assumption: a FUTURE-dated schedule that must
  // not govern today's loads. If `limitInForce` took the newest row this
  // would raise the vault limit six months early.
  await postCashLimitsSchedule(
    R({ asset_id: "casset_vault1", limit_cents: 2_000_000_00,
        effective_at: "2027-01-01T00:00:00.000Z", board_resolution_id: "board-2027-001" }),
    env.db, "d", compliance,
  );

  // permitted: 500k + 100k = 600k, under the 750k limit, two people
  await postCashLoad(
    R({ amount_cents: 100_000_00, counter_user_id: "teller_1", custodian_user_id: "cust_1" }),
    "casset_vault1", env.db, "d", ops,
  );
  // NEGATIVE: would breach the limit in force
  await postCashLoad(
    R({ amount_cents: 300_000_00, counter_user_id: "teller_1", custodian_user_id: "cust_1" }),
    "casset_vault1", env.db, "d", ops,
  );
  // NEGATIVE: one person doing both halves of dual control
  await postCashLoad(
    R({ amount_cents: 1_000_00, counter_user_id: "teller_1", custodian_user_id: "teller_1" }),
    "casset_atm1", env.db, "d", ops,
  );
  // NEGATIVE: no limit in force — unknown is not permission
  await postCashLoad(
    R({ amount_cents: 1_000_00, counter_user_id: "teller_1", custodian_user_id: "cust_2" }),
    "casset_drawer_unlimited", env.db, "d", ops,
  );

  // CP-03: warning band, then a breach, then a remediation that actually works
  await postCashEnterprisePosition(
    R({ as_of_date: "2026-05-31", cash_cents: 1_200_000_00,
        gl_total_assets_cents: 50_000_000_00, limit_bp: 300, warning_bp: 200 }),
    env.db, "d", compliance,
  );
  await postCashEnterprisePosition(
    R({ as_of_date: "2026-06-30", cash_cents: 2_000_000_00,
        gl_total_assets_cents: 50_000_000_00, limit_bp: 300, warning_bp: 200 }),
    env.db, "d", compliance,
  );
  // NEGATIVE: a remediation claimed while the position is still over the limit
  await postCashEnterpriseRemediation(
    R({ action: "swept to correspondent", cash_cents: 1_900_000_00 }),
    "cashent_20260630", env.db, "d", compliance,
  );
  await postCashEnterpriseRemediation(
    R({ action: "swept to correspondent", cash_cents: 1_400_000_00 }),
    "cashent_20260630", env.db, "d", compliance,
  );
  // NEGATIVE: a position with NO Board limit set. It must report `unassessed`
  // rather than "within limit", which is the flattering reading of a decision
  // nobody made.
  await postCashEnterprisePosition(
    R({ as_of_date: "2026-07-31", cash_cents: 3_000_000_00,
        gl_total_assets_cents: 50_000_000_00 }),
    env.db, "d", compliance,
  );

  // CP-06: a clean day and a day that does not balance
  await postCashReconciliation(
    R({ business_date: "2026-07-15", counted_cents: 600_000_00, gl_balance_cents: 600_000_00 }),
    "casset_vault1", env.db, "d", ops,
  );
  await postCashReconciliation(
    R({ business_date: "2026-07-16", counted_cents: 599_950_00,
        gl_balance_cents: 600_000_00, research_notes: "strap miscount under review" }),
    "casset_vault1", env.db, "d", ops,
  );
  // age the suspense item so the sweep has a real escalation — THROUGH the
  // client, never by poking the row store: a direct mutation ages the fake's
  // copy and leaves a real database untouched (found by the live tier, where
  // the sweep found nothing due and CP-06 went red)
  const sus = (env.rows["core.gl_cash_suspense"] ?? [])[0];
  if (sus) {
    // ALSO reset escalated/cleared: the suspense id is deterministic, so on a
    // live database a prior run's clear survives into this run and the sweep
    // would skip the row forever (cleared_at is its exit condition)
    await env.db.schema("core").from("gl_cash_suspense")
      .update({
        escalate_at: "2020-01-01T00:00:00.000Z",
        escalated_at: null,
        cleared_at: null,
      }).eq("id", String(sus.id));
    sus.escalate_at = "2020-01-01T00:00:00.000Z";
  }
  await postCashSuspenseSweep(R({}), env.db, "d", ops);
  await postCashSuspenseClear(
    R({ correction_txn_id: "gl_txn_9911" }), String(sus?.id ?? "none"), env.db, "d", ops,
  );

  // CP-07: three shorts by the same custodian. Individually noise; cumulative
  // they cross the threshold and raise a BSA alert.
  for (const [i, amt] of [-2_000, -1_800, -9_000].entries()) {
    await postCashOverShort(
      R({
        custodian_user_id: "teller_9", business_date: `2026-07-1${i}`,
        amount_cents: amt, threshold_cents: 10_000,
        research_notes: i === 2 ? "no explanation found" : undefined,
      }),
      "casset_atm1", env.db, "d", ops,
    );
  }
  const osRow = (env.rows["core.cash_overshort"] ?? [])[0];
  await postCashOverShortResolve(
    R({ research_notes: "recount located the difference" }),
    String(osRow?.id ?? "none"), env.db, "d", ops,
  );
  // CP-07: the pattern was real but below the BSA line — the graduated
  // response is coaching, recorded like any other control evidence
  await postEmployeeCoaching(
    R({ cause_type: "cash_overshort", cause_id: String(osRow?.id ?? "none"),
        notes: "repeat small shorts; recount training assigned" }),
    "emp_t1", env.db, "d", ops,
  );

  // CP-08: a good shipment, a seal mismatch, and a border crossing over $10k
  await postCashShipment(
    R({ id: "cship_ok", asset_id: "casset_vault1", direction: "inbound",
        amount_cents: 250_000_00, seal_expected: "SEAL-A1", courier_receipt_id: "crt-1" }),
    env.db, "d", ops,
  );
  await postCashShipmentVerify(
    R({ seal_found: "SEAL-A1", counter_user_id: "teller_1", custodian_user_id: "cust_1" }),
    "cship_ok", env.db, "d", ops,
  );
  await postCashShipment(
    R({ id: "cship_bad", asset_id: "casset_vault1", direction: "inbound",
        amount_cents: 100_000_00, seal_expected: "SEAL-B2", courier_receipt_id: "crt-2" }),
    env.db, "d", ops,
  );
  // NEGATIVE: the seal does not match. This is an incident, not a note.
  await postCashShipmentVerify(
    R({ seal_found: "SEAL-B7", counter_user_id: "teller_1", custodian_user_id: "cust_1" }),
    "cship_bad", env.db, "d", ops,
  );
  await postCashShipment(
    R({ id: "cship_intl", direction: "outbound", amount_cents: 45_000_00,
        seal_expected: "SEAL-C3", crosses_border: true, courier_receipt_id: "crt-3" }),
    env.db, "d", ops,
  );
  await postCashNightDropRetrieval(
    R({ counter_user_id: "teller_2", custodian_user_id: "cust_1", bag_count: 4 }),
    "casset_vault1", env.db, "d", ops,
  );

  // CP-09
  await postCashSurpriseCountSchedule(
    R({ asset_id: "casset_atm1", scheduled_for: "2026-07-18" }), env.db, "d", compliance,
  );
  await postCashSurpriseCountComplete(
    R({ counted_cents: 39_900_00, counted_by: "auditor_1" }),
    "cashsc_casset_atm1_20260718", env.db, "d", compliance,
  );

  // CP-10: a seasonal deviation, refused without a bond adjustment and then
  // approved with one
  await postCashDeviationRequest(
    R({ asset_id: "casset_atm1", requested_limit_cents: 120_000_00,
        period_reason: "holiday season", sunset_at: "2027-01-15T00:00:00.000Z" }),
    env.db, "d", compliance,
  );
  const dev = (env.rows["core.cash_deviation"] ?? [])[0];
  await postCashDeviationDecision(
    R({ decision: "approved", board_resolution_id: "board-2026-044" }),
    String(dev?.id ?? "none"), env.db, "d", compliance,
  );
  await postCashDeviationDecision(
    R({ decision: "approved", board_resolution_id: "board-2026-044",
        insurance_bond_adjustment: "bond rider +$60k" }),
    String(dev?.id ?? "none"), env.db, "d", compliance,
  );

  await postCashException(
    R({ kind: "limit_override", rationale: "armoured car delayed 48h",
        risk_acceptance: "accepted by CFO for the period",
        accepted_by: "cfo_01", asset_id: "casset_vault1" }),
    env.db, "d", compliance,
  );

  await postCashKriPublish(R({ period: "2026-07" }), env.db, "d", compliance);
  await postCashBoardSummary(R({ quarter: "2026Q3" }), env.db, "d", compliance);

  // CP-09 / CP-12: the examiner export, with a declared scope
  await postCashRecordsPackage(
    R({
      purpose: "exam_export",
      scope: { period: "2026Q3", assets: ["casset_vault1", "casset_atm1"] },
      delivered_to: "NCUA examiner team",
    }),
    env.db, "d", compliance,
  );

  // CP-12 also declares the retention lifecycle. Those writers already exist,
  // so the cash evidence is clocked through them rather than duplicated.
  // fixture THROUGH the client — a pushed row only ages the fake's copy
  await env.db.schema("core").from("record").upsert({
    id: `rec_cash_${env.n()}`, record_class: "cash_operations", subject_ref: "casset_vault1",
    retention_anchor: "2014-01-01T00:00:00.000Z", retention_anchor_kind: "creation",
    retention_expires_at: "2019-01-01T00:00:00.000Z",
    legal_hold_flag: false, disposed_at: null, provenance: "production",
  }, { onConflict: "id" });
  await setRetentionClocks(env.db, "casset_vault1", new Date());
  await postDisposalSweep(R({}), env.db, "d", env.actors.ops);
}

/**
 * Records administration, driven end to end.
 *
 * Schedule A registered and then AMENDED -> a class with no schedule entry
 * (which must refuse, not default) -> a permanent class that never becomes
 * disposal eligible -> integrity tests that pass and fail -> archive
 * confirmations -> storage boxes reconciled against actual disposals ->
 * risk-based CDD refresh -> anonymization rather than destruction for BSA
 * records -> annual policy review -> a records contact assigned and vacated.
 */
async function runRecordsAdminLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.retention_schedule_entry"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  // RR-01: Schedule A as data, with a citation.
  await postRetentionScheduleEntry(
    R({ record_class: "cip_identity", retention_years: 5, anchor_kind: "account_closed",
        citation: "31 CFR 1020.220", effective_at: "2026-01-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  // schedule_a.entry.added only fires for a class with NO in-force entry —
  // on the live tier every fixed class already has one from prior runs, so a
  // run-unique probe class is what keeps the ADD path reachable there
  await postRetentionScheduleEntry(
    R({ record_class: `drill_probe_${env.n()}`, retention_years: 1, anchor_kind: "created",
        citation: "drill probe — exercises the Schedule A add path",
        effective_at: "2026-01-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  // and an AMENDMENT, which supersedes and inherits
  await postRetentionScheduleEntry(
    R({ record_class: "cip_identity", retention_years: 7, anchor_kind: "account_closed",
        citation: "31 CFR 1020.220", effective_at: "2026-06-01T00:00:00.000Z",
        amended_by: "records_officer" }),
    env.db, "d", ops,
  );
  await postRetentionScheduleEntry(
    R({ record_class: "bsa_sar", retention_years: 5, anchor_kind: "filed",
        citation: "31 CFR 1020.320", effective_at: "2026-01-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  // RR-11: a PERMANENT class
  await postRetentionScheduleEntry(
    R({ record_class: "charter", permanent: true, anchor_kind: "created",
        citation: "12 CFR 701", effective_at: "2026-01-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  // NEGATIVE: a schedule entry with no citation
  await postRetentionScheduleEntry(
    R({ record_class: "misc", retention_years: 3, anchor_kind: "created" }), env.db, "d", ops,
  );

  await postRecordClassify(
    R({ record_class: "cip_identity", record_id: "rec_ra_1", subject_ref: "acct_ra" }),
    env.db, "d", ops,
  );
  await postRecordClassify(
    R({ record_class: "charter", record_id: "rec_ra_perm", subject_ref: "org" }),
    env.db, "d", ops,
  );
  // NEGATIVE: a class with no Schedule A entry must REFUSE, not default
  await postRecordClassify(
    R({ record_class: "mystery_class", record_id: "rec_ra_unk" }), env.db, "d", ops,
  );

  // RR-02 / RR-06: integrity tests, one passing and one failing
  await postIntegrityTestSchedule(
    R({ subject_kind: "record", subject_ref: "rec_ra_1", test_kind: "conversion" }),
    env.db, "d", ops,
  );
  await postIntegrityTestComplete(
    R({ passed: true, sample_size: 25, certified_by: "records_officer" }),
    "rint_record_rec_ra_1_conversion", env.db, "d", ops,
  );
  await postIntegrityTestSchedule(
    R({ subject_kind: "email_archive", subject_ref: "exchange", test_kind: "readability" }),
    env.db, "d", ops,
  );
  // NEGATIVE: a failing test must open a finding
  await postIntegrityTestComplete(
    R({ passed: false, sample_size: 40, certified_by: "records_officer" }),
    "rint_email_archive_exchange_readability", env.db, "d", ops,
  );
  await postIntegrityTestSchedule(
    R({ subject_kind: "core_archive", subject_ref: "core_vendor", test_kind: "completeness" }),
    env.db, "d", ops,
  );
  await postIntegrityTestComplete(
    R({ passed: true, sample_size: 10, certified_by: "records_officer",
        retention_years_confirmed: 7 }),
    "rint_core_archive_core_vendor_completeness", env.db, "d", ops,
  );
  await postArchiveConfirmation(
    R({ archive_kind: "core_archive", period: "2026", vendor_ref: "core_vendor",
        retention_years_confirmed: 7, confirmed_by: "records_officer" }),
    env.db, "d", ops,
  );

  // RR-04: a box marked destroyed whose records are still live
  await postStorageBox(
    R({ id: "sbox_1", label: "BOX-2019-A", location: "offsite",
        record_ids: ["rec_ra_1", "rec_ra_perm"] }),
    env.db, "d", ops,
  );
  await env.db.schema("core").from("storage_box")
    .update({ destroyed_at: "2026-07-01T00:00:00.000Z" }).eq("id", "sbox_1");
  await postDestructionLogReconcile(R({}), env.db, "d", ops);
  await postDestructionLogResolve(
    R({ resolution: "records recalled from offsite; box re-opened" }),
    "dlmm_sbox_1", env.db, "d", ops,
  );

  // RR-08: risk-based CDD
  await postCddProfile(
    R({ id: "cdd_high", entity_id: "ent_1", risk_tier: "high",
        last_refreshed_at: "2024-01-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  await postCddRefresh(R({ refreshed_by: "bsa_analyst" }), "cdd_high", env.db, "d", ops);

  // RR-07: a BSA record ANONYMIZED rather than destroyed
  // fixture THROUGH the client — a pushed row ages the fake's copy and
  // leaves a real database untouched (the live tier read these controls red)
  // run-unique id: disposal is IRREVERSIBLE (freeze_disposal), so a converged
  // id would hit last run's destroyed row and the re-upsert would be refused
  const recRaBsa = `rec_ra_bsa_${env.n()}`;
  await env.db.schema("core").from("record").upsert({
    id: recRaBsa, record_class: "bsa_sar", subject_ref: "case_1",
    retention_anchor: "2014-01-01T00:00:00.000Z", retention_anchor_kind: "creation",
    retention_expires_at: "2019-01-01T00:00:00.000Z",
    legal_hold_flag: false, disposed_at: null, provenance: "production",
  }, { onConflict: "id" });
  await postRecordDisposition(
    R({ method: "anonymized", approved_by: "bsa_officer",
        retained_fields: ["amount_band", "typology"] }),
    recRaBsa, env.db, "d", ops,
  );
  // NEGATIVE: a permanent record can never be disposed, whatever the method
  await postRecordDisposition(
    R({ method: "destroyed", approved_by: "records_officer" }),
    "rec_ra_perm", env.db, "d", ops,
  );

  // RR-09 / RR-12
  await postRecordsPolicyReview(
    R({ cycle_year: 2026, reviewed_by: "records_officer",
        policy_document_version: "rr-v3.0",
        regulation_changes: ["31 CFR 1020.220 amended"] }),
    env.db, "d", ops,
  );
  await putRecordsContact(
    R({ assigned_ref: "records_officer" }), "records_officer", env.db, "d", ops,
  );
  // a VACANCY, which is the state that must not look like "role never existed"
  await putRecordsContact(R({ vacate: true }), "records_liaison", env.db, "d", ops);

  // RR-03's disposal.scheduled comes from the EXISTING sweep, which is what
  // evaluates the three eligibility conditions.
  await postDisposalSweep(R({}), env.db, "d", ops);
}

/**
 * Lending underwriting, driven end to end.
 *
 * Product config -> eligibility screen (and a prohibited-practice refusal) ->
 * credit file assembled, decisioned and SEALED -> credit report freshness and
 * score tolerance -> ATR/QM with a DTI breach that opens an exception ->
 * appraisal ordered, delivered, and a reconsideration of value by someone
 * other than the appraiser -> exception decided by a second person ->
 * published rate sheet, HPML test, pricing exception -> prequalification with
 * and without steering -> fair lending disparity and HMDA LAR -> Regulation O
 * insider review.
 */
async function runLendingUwLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.credit_config"] ?? []).length > 0) return;
  const ops = env.actors.ops;
  const APP = "app_uw_1";
  // The applications these controls act on have to EXIST — every writer below
  // updates the application row, and an update against a missing row is a
  // silent no-op that reads as "the datum was never supplied".
  // through the client, NOT env.rows: pushed rows never reach the live
  // database, and every writer below would silently no-op against them there
  for (const id of [APP, "app_uw_2", "app_uw_3", "app_uw_blocked"]) {
    await env.db.schema("core").from("loan_application").upsert({
      id, status: "completed", completed_at: "2026-06-01T00:00:00.000Z",
      decisioned_at: null, final_action: null, funding_block_state: "open",
      provenance: "production",
    }, { onConflict: "id" });
  }

  await postCreditConfig(
    R({ product_code: "mortgage_30", approved_by: "clo_1", min_credit_score: 640,
        max_dti_bp: 4300, max_ltv_bp: 8000,
        prohibited_practices: ["negative_amortization", "prepayment_penalty"],
        effective_at: "2026-01-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  await postProductScreen(R({ product_code: "mortgage_30" }), APP, env.db, "d", ops);
  // NEGATIVE: a prohibited practice
  await postProductScreen(
    R({ product_code: "mortgage_30", requested_practices: ["prepayment_penalty"] }),
    APP, env.db, "d", ops,
  );
  // NEGATIVE: a product with no approved config at all
  await postProductScreen(R({ product_code: "unconfigured" }), APP, env.db, "d", ops);

  // LP-03 reads the party screen status off the application, so the
  // application needs a real party on it rather than an assumed one.
  await postLoanParty(
    R({
      role: "borrower", party_name: "A Applicant",
      identity: { tin_last4: "1234", dob: "1980-01-01" },
      contact: { email: "a@example.test" },
    }),
    APP, env.db, "d", ops,
  );
  await postCreditApplicationRecord(
    R({
      documents: ["paystub", "w2"], alternative_data_used: true,
      applicant: { ref: "mbr_a", name: "A Applicant" },
      data: { purpose: "purchase", occupancy: "primary" },
      income_assets: { monthly_income_cents: 1_000_000, assets_cents: 8_000_000 },
      gmi: { ethnicity: "not_provided", sex: "not_provided" },
      channel: "retail",
    }),
    APP, env.db, "d", ops,
  );
  await postCreditReport(
    R({ bureau: "equifax", score: 610, score_model: "FICO9", min_credit_score: 640 }),
    APP, env.db, "d", ops,
  );
  // NEGATIVE: a stale report cannot support a decision
  await postCreditReport(
    R({ bureau: "experian", score: 700, pulled_at: "2025-01-01T00:00:00.000Z" }),
    APP, env.db, "d", ops,
  );
  await postAtrQm(
    R({ monthly_debt_cents: 500_000, monthly_income_cents: 1_000_000, max_dti_bp: 4300 }),
    APP, env.db, "d", ops,
  );

  await postAppraisalOrder(R({ appraiser_ref: "appr_1" }), APP, env.db, "d", ops);
  // NEGATIVE: the appraiser cannot decide the reconsideration of their own value
  await postAppraisalComplete(
    R({ value_cents: 40_000_000, loan_amount_cents: 36_000_000, max_ltv_bp: 8000,
        rov: { decision: "revised", decided_by: "appr_1" } }),
    "apr_app_uw_1", env.db, "d", ops,
  );
  await postAppraisalComplete(
    R({ value_cents: 40_000_000, loan_amount_cents: 36_000_000, max_ltv_bp: 8000,
        rov: { decision: "upheld", decided_by: "review_appraiser" } }),
    "apr_app_uw_1", env.db, "d", ops,
  );

  await postLoanException(
    R({ loan_application_id: APP, kind: "ltv_over_policy", detail: { ltv_bp: 9000 },
        mitigating_factors: "12 months reserves", submitted_by: "uw_1" }),
    env.db, "d", ops,
  );
  const exc = (env.rows["core.loan_exception"] ?? []).find((e: Any) => e.submitted_by === "uw_1");
  // NEGATIVE: self-approval
  await postLoanExceptionDecision(
    R({ decision: "approved", decided_by: "uw_1" }), String(exc?.id ?? "x"), env.db, "d", ops,
  );
  await postLoanExceptionDecision(
    R({ decision: "approved", decided_by: "cco_1" }), String(exc?.id ?? "x"), env.db, "d", ops,
  );
  // the ATR/QM DTI breach opened its own exception; it has to be DECIDED or
  // closing stays blocked — which is the control working, and the lifecycle
  // has to honour it rather than route around it
  await postLoanExceptionDecision(
    R({ decision: "approved", decided_by: "cco_1" }), `lexc_${APP}_dti`, env.db, "d", ops,
  );
  await postLoanExceptionAnalytics(R({ period: "2026Q3" }), env.db, "d", ops);

  // NEGATIVE: an unpublished rate sheet cannot price a loan
  await postRateSheet(
    R({ product_code: "mortgage_30", base_rate_bp: 650, apor_bp: 600,
        effective_at: "2026-02-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  await postLoanPricing(
    R({ rate_sheet_id: "rsheet_mortgage_30_1769904000000", quoted_apr_bp: 800 }),
    APP, env.db, "d", ops,
  );
  await postRateSheet(
    R({ product_code: "mortgage_30", base_rate_bp: 650, apor_bp: 600, published_by: "treasury_1",
        effective_at: "2026-03-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  const sheet = (env.rows["core.rate_sheet"] ?? []).find((r: Any) => r.published_at);
  await postLoanPricing(
    R({ rate_sheet_id: String(sheet?.id ?? "x"), quoted_apr_bp: 800,
        exception: { requested_by: "lo_1", rationale: "relationship pricing",
                     decision: "approved", decided_by: "cco_1" } }),
    APP, env.db, "d", ops,
  );
  await postPricingExceptionReview(R({ period: "2026Q3" }), env.db, "d", ops);

  await postCreditDecisionRecord(
    R({
      decision: "denied", sealed_by: "uw_1", incomplete: true,
      // 'issued' is the schema's word (counteroffer_status_check:
      // none/issued/accepted/expired) — 'extended' was refused live, taking
      // the whole seal-time application update down with it
      counteroffer_status: "issued",
      counteroffer_terms: { rate_bp: 700, term_months: 240 },
      oral_adverse_decision: true,
      oral_statement: "declined by phone on 2026-07-18, written notice to follow",
    }),
    APP, env.db, "d", ops,
  );
  // NEGATIVE: a sealed file cannot be amended
  await postCreditDecisionRecord(
    R({ decision: "approved", sealed_by: "uw_2" }), APP, env.db, "d", ops,
  );

  // LP-12: a clean prequal and one that withholds an eligible product
  await postPrequalification(
    R({ subject_ref: "mbr_a", decision: "prequalified",
        products_offered: ["mortgage_30", "heloc"], products_eligible: ["mortgage_30", "heloc"] }),
    env.db, "d", ops,
  );
  await postPrequalification(
    R({ subject_ref: "mbr_b", decision: "declined",
        products_offered: [], products_eligible: ["mortgage_30"] }),
    env.db, "d", ops,
  );

  // LP-13
  await postFairLendingAnalysis(
    R({ period: "2026", kind: "disparity", threshold_bp: 500,
        cohorts: { control: { applications: 1000, approvals: 800 },
                   protected: { applications: 400, approvals: 240 } } }),
    env.db, "d", ops,
  );
  await postFairLendingRemediationClose(
    R({ evidence: "underwriter retraining + file re-review" }),
    "flan_2026_disparity", env.db, "d", ops,
  );
  await postFairLendingAnalysis(
    R({ period: "2026", kind: "redlining", threshold_bp: 500,
        cohorts: { inside: { applications: 500, approvals: 400 },
                   outside: { applications: 500, approvals: 390 } } }),
    env.db, "d", ops,
  );
  // NEGATIVE: submitting the LAR before QC
  await postHmdaLar(R({ reporting_year: 2026, record_count: 1240, submitted_by: "compliance_1" }),
    env.db, "d", ops);
  await postHmdaLar(R({ reporting_year: 2026, record_count: 1240, qc_error_count: 0,
    submitted_by: "compliance_1" }), env.db, "d", ops);

  // LP-14
  await putInsider(
    R({ subject_ref: "dir_1", role: "director", effective_from: "2026-01-01T00:00:00.000Z" }),
    "ins_dir1", env.db, "d", ops,
  );
  // NOT an insider — a real answer that gets recorded
  await postInsiderLoanReview(R({ subject_ref: "mbr_zz" }), APP, env.db, "d", ops);
  // NEGATIVE: preferential terms
  await postInsiderLoanReview(
    R({ subject_ref: "dir_1", terms_comparable: false, board_resolution_id: "board-9" }),
    "app_uw_2", env.db, "d", ops,
  );
  await postInsiderLoanReview(
    R({ subject_ref: "dir_1", terms_comparable: true, board_resolution_id: "board-9",
        amount_cents: 25_000_000, aggregate_credit_amount: 42_000_000,
        proposed_terms: { rate_bp: 650, term_months: 360 } }),
    "app_uw_3", env.db, "d", ops,
  );
  // DF-05: the aggregate crosses 5% of unimpaired capital+surplus — the
  // threshold event fires, board approval is on file, terms at parity
  await postInsiderLoanReview(
    R({ subject_ref: "dir_1", terms_comparable: true, board_resolution_id: "board-10",
        amount_cents: 60_000_000, aggregate_credit_amount: 60_000_000,
        unimpaired_capital_surplus_cents: 1_000_000_000,
        board_disinterested_quorum: true,
        proposed_terms: { rate_bp: 700, term_months: 240 },
        comparable_terms: { rate_bp: 700, term_months: 240 } }),
    "app_uw_4", env.db, "d", ops,
  );

  // LP-04 / LP-07: the adverse action, through the EXISTING notice table
  await postLendingAdverseAction(
    R({ reasons: ["credit score below minimum"], reviewed_by: "cco_1", oral: true }),
    APP, env.db, "d", ops,
  );

  // LP-09 / LP-03 / LP-06: booking, which writes core.loan and its LTV.
  // NEGATIVE first: an undecided exception must block closing.
  await postLoanException(
    R({ loan_application_id: "app_uw_blocked", kind: "doc_waiver", detail: {},
        mitigating_factors: "verbal confirmation", submitted_by: "uw_1" }),
    env.db, "d", ops,
  );
  await postLoanBooking(
    R({ booked_by: "closer_1", principal_cents: 36_000_000, value_cents: 40_000_000 }),
    "app_uw_blocked", env.db, "d", ops,
  );
  await postLoanBooking(
    R({ booked_by: "closer_1", principal_cents: 36_000_000, value_cents: 40_000_000 }),
    APP, env.db, "d", ops,
  );
}

/**
 * The investment portfolio, driven end to end.
 *
 * Permissible-instrument list -> approved and unapproved intermediaries ->
 * issuer credit files -> concentration limits -> trades that clear the gate and
 * trades blocked on each of its four conditions -> three-role segregation with
 * a confirmation mismatch -> repo with a margin shortfall that issues a call ->
 * fair value with and without impairment -> liquidity classification and the
 * contingency plan -> IRR and stress simulations -> reports and performance.
 */
async function runInvestmentLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.instrument_list"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  // capital position: the concentration limits are a share of net worth
  await postCapitalPosition(
    R({ as_of_date: "2026-03-31", net_worth_cents: 750_000_000, total_assets_cents: 5_000_000_000 }),
    env.db, "d", ops,
  );
  // PIN the latest-dated position too: the trade gate reads the newest
  // capital position by date, and on the live tier other lifecycles leave a
  // $4.2m row at 2026-09-30 — against which the "clean" 30m trade blocks,
  // its id is never returned, and every downstream confirmation/exception
  // references a trade that does not exist (the IP-02/10/11/14/15 defects).
  await postCapitalPosition(
    R({ as_of_date: "2026-09-30", net_worth_cents: 750_000_000, total_assets_cents: 5_000_000_000 }),
    env.db, "d", ops,
  );

  await postInstrumentListEntry(
    R({ instrument_class: "us_treasury", permissible: true, citation: "12 CFR 703.14(a)",
        max_maturity_months: 120, effective_at: "2026-01-01T00:00:00.000Z",
        reviewed_by: "alco_1" }),
    env.db, "d", ops,
  );
  await postInstrumentListEntry(
    R({ instrument_class: "collateralized_mortgage_obligation", permissible: false,
        citation: "12 CFR 703.16", effective_at: "2026-01-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  // NEGATIVE: an entry with no citation
  await postInstrumentListEntry(
    R({ instrument_class: "misc", permissible: true }), env.db, "d", ops,
  );

  await postIntermediary(
    R({ name: "Northgate Securities", kind: "both", regulator: "finra",
        registration_status: "active" }),
    env.db, "d", ops,
  );
  // NEGATIVE: an unregulated counterparty must not be approved
  await postIntermediary(
    R({ name: "Backstreet Brokers", kind: "broker_dealer", regulator: "none",
        registration_status: "active" }),
    env.db, "d", ops,
  );

  await postCreditFile(
    R({ issuer_ref: "us_gov", internal_rating: "AAA", analysis_ref: "an-1",
        approved_by: "cio_1", external_rating: "AAA" }),
    env.db, "d", ops,
  );
  // NEGATIVE: reliance on an external rating with no internal analysis
  await postCreditFile(R({ issuer_ref: "acme", external_rating: "A" }), env.db, "d", ops);
  await postCreditFileReanalysis(
    R({ internal_rating: "AA", analysis_ref: "an-2" }), "cfile_us_gov", env.db, "d", ops,
  );

  await putLimitSet(
    R({ scope_kind: "issuer", scope_ref: "us_gov", limit_bp_of_capital: 5000,
        warning_bp_of_capital: 4000, approved_by: "board-2026-01",
        effective_at: "2026-01-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  // NEGATIVE: a warning at or above the limit never fires first
  await putLimitSet(
    R({ scope_kind: "issuer", scope_ref: "acme", limit_bp_of_capital: 1000,
        warning_bp_of_capital: 1000, approved_by: "board-2026-01" }),
    env.db, "d", ops,
  );

  // fixture securities go through the client, not into env.rows directly:
  // rows[] is only the fake's store — on the live tier it is a recorder, and
  // a row pushed there never reaches core.security, so every trade below
  // would violate trade_security_id_fkey (the investment cluster's original
  // fake-vs-real defect).
  for (const [id, iss, cls] of [
    ["sec_ust1", "us_gov", "us_treasury"],
    ["sec_cmo1", "acme", "collateralized_mortgage_obligation"],
  ]) {
    await env.db.schema("core").from("security").upsert({
      id, issuer_ref: iss, instrument_class: cls, external_rating: "AAA",
      provenance: "production",
    }, { onConflict: "id" });
    // positions converge on pos_<security> and ACCUMULATE par across runs
    // (read-modify-write in postTrade) — reset so the warning/breach bands
    // the arc is built on hold on every run, not only the first
    await env.db.schema("core").from("position").upsert({
      id: `pos_${id}`, security_id: id, par_cents: 0, book_value_cents: 0,
      provenance: "production",
    }, { onConflict: "id" });
  }

  // IP-14: the segregation matrix needs to know what role each actor holds,
  // and it binds to the CREDENTIAL — so each role acts under its own token id,
  // registered BEFORE anyone trades (an unregistered executor is refused).
  for (const [u, role] of [
    ["trader_1", "execution"], ["trader_2", "execution"],
    ["ops_confirm", "confirmation"], ["ops_settle", "settlement"], ["cio_1", "oversight"],
  ]) {
    await putUserRole(R({ role }), u, env.db, "d", ops);
  }

  const as = (u: string) => ({ ...ops, tokenId: u });

  // clean trade — id captured from the RESPONSE: scanning env.rows for
  // executed trades breaks on the live tier, where the recorder also appends
  // id-less update payloads (the trade_exception FK refusals' cause)
  const cleanTradeRes = await postTrade(
    R({ security_id: "sec_ust1", instrument_class: "us_treasury", issuer_ref: "us_gov",
        intermediary_id: "interm_northgatesecurities", side: "buy", par_cents: 30_000_000,
        price_bp: 9950, executed_by: "trader_1", maturity_months: 60,
        checklist_completed: true, instrument_type: "bill",
        settlement_amount_cents: 29_850_000, valuation_support: "bloomberg_quote" }),
    env.db, "d", as("trader_1"),
  );
  const cleanTradeId = String(
    ((await cleanTradeRes.clone().json().catch(() => ({}))) as Any)?.data?.id ?? "x",
  );
  // NEGATIVE: a prohibited instrument class
  await postTrade(
    R({ security_id: "sec_cmo1", instrument_class: "collateralized_mortgage_obligation",
        issuer_ref: "acme", intermediary_id: "interm_northgatesecurities", side: "buy",
        par_cents: 1_000_000, executed_by: "trader_1", checklist_completed: true }),
    env.db, "d", as("trader_1"),
  );
  // NEGATIVE: an unapproved counterparty
  await postTrade(
    R({ security_id: "sec_ust1", instrument_class: "us_treasury", issuer_ref: "us_gov",
        intermediary_id: "interm_backstreetbrokers", side: "buy", par_cents: 1_000_000,
        executed_by: "trader_1", checklist_completed: true }),
    env.db, "d", as("trader_1"),
  );
  // NEGATIVE: no pre-purchase checklist
  await postTrade(
    R({ security_id: "sec_ust1", instrument_class: "us_treasury", issuer_ref: "us_gov",
        intermediary_id: "interm_northgatesecurities", side: "buy", par_cents: 1_000_000,
        executed_by: "trader_1" }),
    env.db, "d", as("trader_1"),
  );
  // lands in the WARNING band: 30m held + 300m = 330m against 750m of net
  // worth is 4400bp, over the 4000bp warning and under the 5000bp limit. The
  // warning has to fire on a trade that still EXECUTES, or it is just a
  // second name for the block.
  const warnTradeRes = await postTrade(
    R({ security_id: "sec_ust1", instrument_class: "us_treasury", issuer_ref: "us_gov",
        intermediary_id: "interm_northgatesecurities", side: "buy", par_cents: 300_000_000,
        price_bp: 9950, executed_by: "trader_2", maturity_months: 60,
        checklist_completed: true, instrument_type: "note",
        settlement_amount_cents: 298_500_000, valuation_support: "bloomberg_quote" }),
    env.db, "d", as("trader_2"),
  );
  const warnTradeId = String(
    ((await warnTradeRes.clone().json().catch(() => ({}))) as Any)?.data?.id ?? "x",
  );
  // NEGATIVE: this one BREACHES on the projected position — 330m held plus
  // 100m more is 5733bp against a 5000bp limit
  await postTrade(
    R({ security_id: "sec_ust1", instrument_class: "us_treasury", issuer_ref: "us_gov",
        intermediary_id: "interm_northgatesecurities", side: "buy", par_cents: 100_000_000,
        executed_by: "trader_1", checklist_completed: true }),
    env.db, "d", as("trader_1"),
  );

  const tid = cleanTradeId;
  // NEGATIVE: the executing trader cannot confirm their own trade
  await postTradeConfirmation(
    R({ confirmed_by: "trader_1", confirmation_ref: "c1", counterparty_par_cents: 30_000_000 }),
    tid, env.db, "d", as("trader_1"),
  );
  // a real confirmation, with a MISMATCH against the counterparty's figures
  await postTradeConfirmation(
    R({ confirmed_by: "ops_confirm", confirmation_ref: "c1", counterparty_par_cents: 29_000_000 }),
    tid, env.db, "d", as("ops_confirm"),
  );
  // and one that MATCHES, so "matched" is not simply an event nobody can reach
  if (warnTradeId !== "x" && warnTradeId !== tid) {
    await postTradeConfirmation(
      R({
        confirmed_by: "ops_confirm", confirmation_ref: "c2",
        counterparty_par_cents: 300_000_000,
      }),
      warnTradeId, env.db, "d", as("ops_confirm"),
    );
  }
  // NEGATIVE: the executing trader cannot settle either
  await postTradeReconciliation(R({ settled_by: "trader_1" }), tid, env.db, "d", as("trader_1"));
  await postTradeReconciliation(R({ settled_by: "ops_settle" }), tid, env.db, "d", as("ops_settle"));

  await postTradeException(
    R({ trade_id: tid, kind: "limit_waiver", detail: { bp: 100 }, raised_by: "trader_1",
        approved_by: "cio_1" }),
    env.db, "d", ops,
  );
  // NEGATIVE: self-approved exception
  await postTradeException(
    R({ kind: "late_confirmation", detail: {}, raised_by: "trader_1", approved_by: "trader_1" }),
    env.db, "d", ops,
  );

  await postSafekeepingReconciliation(
    R({ intermediary_id: "interm_northgatesecurities",
        holdings: { sec_ust1: 29_000_000 } }),
    env.db, "d", ops,
  );

  // repo with a margin shortfall, and one blocked on the counterparty
  await postRepoAgreement(
    R({ intermediary_id: "interm_northgatesecurities", direction: "reverse_repo",
        principal_cents: 10_000_000, collateral_value_cents: 10_100_000,
        required_margin_bp: 200 }),
    env.db, "d", ops,
  );
  await postRepoAgreement(
    R({ intermediary_id: "interm_backstreetbrokers", direction: "repo",
        principal_cents: 5_000_000, collateral_value_cents: 5_500_000,
        required_margin_bp: 200 }),
    env.db, "d", ops,
  );

  // fair value: one impaired, one not
  await postFairValue(
    R({ fair_value_cents: 28_000_000, source: "bloomberg_level_1",
        amortized_cost_cents: 30_000_000 }),
    "sec_ust1", env.db, "d", ops,
  );
  await postFairValue(
    R({ fair_value_cents: 1_100_000, source: "broker_quote_level_2",
        amortized_cost_cents: 1_000_000 }),
    "sec_cmo1", env.db, "d", ops,
  );
  // NEGATIVE: a fair value with no source
  await postFairValue(R({ fair_value_cents: 1 }), "sec_ust1", env.db, "d", ops);

  await postSecurityDowngrade(
    R({ new_rating: "BB", reviewed_by: "cio_1", disposition: "hold" }),
    "sec_cmo1", env.db, "d", ops,
  );

  await postLiquidityClassification(
    R({ security_id: "sec_ust1", liquidity_class: "level_1" }), env.db, "d", ops,
  );
  await postLiquidityClassification(
    R({ security_id: "sec_cmo1", liquidity_class: "level_3" }), env.db, "d", ops,
  );
  await postLiquidityReport(R({ period: "2026Q3", min_marketable_bp: 5000 }), env.db, "d", ops);

  // NEGATIVE: activating a contingency level with no execution plan
  await postCfpLevelChange(R({ level: "stress", changed_by: "alco_1" }), env.db, "d", ops);
  await postCfpLevelChange(
    R({ level: "stress", changed_by: "alco_1", execution_plan_ref: "cfp-plan-3",
        trigger_detail: { marketable_bp: 4200 }, investment_test_completed: true }),
    env.db, "d", ops,
  );

  await postAlmSimulation(
    R({ kind: "irr", period: "2026Q3", scenario: "+300bp", result_bp: 850, minimum_bp: 600 }),
    env.db, "d", ops,
  );
  await postAlmSimulation(
    R({ kind: "stress", period: "2026Q3", scenario: "severe", result_bp: 400, minimum_bp: 600 }),
    env.db, "d", ops,
  );
  await postAlmSimulation(
    R({ kind: "portfolio_stress", period: "2026Q3", scenario: "rate_shock",
        result_bp: 700, minimum_bp: 600 }),
    env.db, "d", ops,
  );

  await postPortfolioReport(R({ period: "2026Q3", audience: "board" }), env.db, "d", ops);
  await postPortfolioReport(R({ period: "2026Q3", audience: "management" }), env.db, "d", ops);
  await postPerformanceMeasurement(
    R({ period: "2026Q3", portfolio_return_bp: 420, benchmark_ref: "ICE BofA 1-3Y",
        benchmark_return_bp: 390, attribution: { duration: 20, selection: 10 } }),
    env.db, "d", ops,
  );
}

/**
 * Complaints and Reg E disputes, driven end to end.
 *
 * Intake through four channels -> acknowledgement (one late) -> initial and
 * final responses -> resolution with a root cause -> a Reg E dispute with its
 * separate provisional-credit and investigation clocks -> trend analysis under
 * three lenses -> board reporting, quarterly and ad hoc.
 */
async function runComplaintsLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.complaint"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  // a direct complaint, handled properly
  await postComplaint(
    R({ channel: "direct", category: "fees", member_id: "mbr_1",
        narrative: "charged an NSF fee twice for the same item",
        entity_contact: { email: "m1@example.test", phone: "+15550111" },
        received_at: "2026-07-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  const c1 = String((env.rows["core.complaint"] ?? [])[0]?.id ?? "x");
  await postComplaintAcknowledge(R({ acknowledged_by: "svc_1" }), c1, env.db, "d", ops);
  await postComplaintResponse(
    R({ stage: "initial", body_ref: "resp-1" }), c1, env.db, "d", ops,
  );
  await postComplaintResponse(R({ stage: "final", body_ref: "resp-2" }), c1, env.db, "d", ops);
  // NEGATIVE: resolving with no root cause must be refused
  await postComplaintResolve(R({ investigation_notes: "n" }), c1, env.db, "d", ops);
  await postComplaintResolve(
    R({ root_cause_tag: "duplicate_fee_posting", investigation_notes: "system defect" }),
    c1, env.db, "d", ops,
  );

  // a regulator-channel complaint, which carries the longer clock
  await postComplaint(
    R({ channel: "regulator", category: "fair_lending", member_id: "mbr_2",
        regulator: "CFPB", regulator_case_id: "CFPB-2026-1",
        narrative: "denied a loan on grounds the member believes discriminatory",
        udaap_flag: true, received_at: "2026-07-05T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  // NEGATIVE: a regulator complaint with no regulator named
  await postComplaint(
    R({ channel: "regulator", category: "other", narrative: "x" }), env.db, "d", ops,
  );
  // a privacy complaint, which PR-10 reads
  await postComplaint(
    R({ channel: "portal", category: "privacy", member_id: "mbr_3",
        narrative: "opt-out was not honoured", received_at: "2026-07-10T00:00:00.000Z",
        entity_contact: { email: "m3@example.test" } }),
    env.db, "d", ops,
  );
  // NEGATIVE: no narrative
  await postComplaint(R({ channel: "phone", category: "service" }), env.db, "d", ops);

  // NEGATIVE: resolving before the member has been answered
  const c2 = (env.rows["core.complaint"] ?? []).find((c: Any) => c.category === "privacy");
  await postComplaintResolve(
    R({ root_cause_tag: "process_gap" }), String(c2?.id ?? "x"), env.db, "d", ops,
  );

  // a Reg E dispute, with its own clocks
  await postDispute(
    R({ complaint_id: c1, member_id: "mbr_1", account_id: "acct_1",
        basis: "unauthorised card transaction", amount_cents: 45_000,
        account_balance_cents: 250_000, notified_at: "2026-07-02T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  const d1 = String((env.rows["core.dispute"] ?? [])[0]?.id ?? "x");
  await postProvisionalCredit(R({}), d1, env.db, env.cfg, "d", ops);
  // NEGATIVE: resolving with no findings
  await postDisputeResolve(R({}), d1, env.db, "d", ops);
  await postDisputeResolve(
    R({ findings: "merchant confirmed the charge was not authorised",
        correction_amount_cents: 45_000 }),
    d1, env.db, "d", ops,
  );

  // trend analysis under each lens, one of which breaches
  await postComplaintTrend(R({ period: "2026Q3", lens: "collections" }), env.db, "d", ops);
  await postComplaintTrend(R({ period: "2026Q3", lens: "privacy" }), env.db, "d", ops);
  await postComplaintTrend(
    R({ period: "2026Q3", lens: "fair_lending", threshold_bp: 500,
        cohorts: { control: 200, protected: 900 } }),
    env.db, "d", ops,
  );
  await postComplaintBoardReport(R({ period: "2026Q3", audience: "compliance" }), env.db, "d", ops);
  await postComplaintBoardReport(
    R({ period: "2026Q3", audience: "privacy", adhoc: true,
        material_incident_id: "inc_1" }),
    env.db, "d", ops,
  );
}

/**
 * Risk breaches, acceptances and control overrides, driven end to end.
 *
 * Appetite set -> an observation INSIDE appetite (which still records that the
 * check ran) -> one outside, opening a breach with its clocks -> committee
 * presentation with a plan -> a risk acceptance that must not be self-granted
 * and must expire -> the sweep that warns and then expires it, re-opening the
 * breach -> control overrides and a registered exception that reverts.
 */
async function runRiskExceptionsLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.risk_appetite"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  // the REGISTER first — a breach is an excursion on a registered risk
  await putRisk(
    R({ title: "Consumer credit deterioration", taxonomy_category_code: "credit",
        owner_id: "cro_1", inherent_rating: "high", residual_rating: "moderate",
        remediation_evidence: "underwriting-tightening-2026" }),
    "risk_credit_1", env.db, "d", ops,
  );
  // NEGATIVE: a risk with no owner is a risk nobody is accountable for
  await putRisk(R({ title: "Unowned", taxonomy_category_code: "ops" }), "risk_x", env.db, "d", ops);

  await putRiskAppetite(
    R({ risk_id: "risk_credit_1", taxonomy_category_code: "credit", kri_name: "delinquency_pct",
        tolerance_value: 300, direction: "above", owner_id: "cro_1",
        document_ref: "appetite-2026", approved_by: "board-2026-02" }),
    "rapp_credit", env.db, "d", ops,
  );

  // INSIDE appetite — must record that the check ran and open nothing
  await postRiskObservation(
    R({ appetite_id: "rapp_credit", kri_value: 180 }), env.db, "d", ops,
  );
  // OUTSIDE, and far enough outside to be critical
  await postRiskObservation(
    R({ appetite_id: "rapp_credit", kri_value: 700, residual_rating: "high",
        impact_summary: "consumer book deteriorating" }),
    env.db, "d", ops,
  );
  const br = (env.rows["core.risk_breach"] ?? [])[0];
  // NEGATIVE: presenting with no remediation plan
  await postRiskBreachPresentation(R({}), String(br?.id ?? "x"), env.db, "d", ops);
  await postRiskBreachPresentation(
    R({ remediation_plan: "tighten underwriting on the affected segment",
        remediation_status: "in_progress" }),
    String(br?.id ?? "x"), env.db, "d", ops,
  );

  // NEGATIVE: an acceptance with no expiry
  await postRiskAcceptance(
    R({ risk_id: "risk_credit_1", owner_id: "cro_1", rationale: "seasonal" }),
    env.db, "d", ops,
  );
  // NEGATIVE: an expiry so soon it can never be revisited in time
  await postRiskAcceptance(
    R({ risk_id: "risk_credit_1", owner_id: "cro_1", rationale: "seasonal",
        expiry_date: "2026-07-25T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  await postRiskAcceptance(
    R({ risk_id: "risk_credit_1", breach_id: String(br?.id ?? ""), owner_id: "cro_1",
        rationale: "remediation lands next quarter; carrying the excursion until then",
        remediation_evidence: "plan-9", expiry_date: "2026-12-31T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  const acc = (env.rows["core.risk_acceptance"] ?? [])[0];
  // ERM-07: decisions are the CCO's (role-gated, attributed to the credential)
  const cco = { ...ops, tokenId: "tok_cco", roles: ["cco" as const] };
  // NEGATIVE: a staff credential without the cco role cannot decide
  await postRiskAcceptanceDecision(
    R({ decision: "accepted", decided_by: "board_chair" }), String(acc?.id ?? "x"), env.db, "d", ops,
  );
  // NEGATIVE: the owner cannot grant their own acceptance
  await postRiskAcceptanceDecision(
    R({ decision: "accepted", decided_by: "cro_1" }), String(acc?.id ?? "x"), env.db, "d", cco,
  );
  await postRiskAcceptanceDecision(
    R({ decision: "accepted", decided_by: "board_chair" }), String(acc?.id ?? "x"),
    env.db, "d", cco,
  );

  // the sweep: first a warning, then expiry re-opening the breach — both
  // backdates through the client so the live rows actually change
  if (acc) {
    await env.db.schema("core").from("risk_acceptance")
      .update({ expiry_alert_at: "2020-01-01T00:00:00.000Z" }).eq("id", String(acc.id));
  }
  await postRiskAcceptanceSweep(R({}), env.db, "d", ops);
  if (acc) {
    await env.db.schema("core").from("risk_acceptance")
      .update({ expiry_date: "2020-01-02T00:00:00.000Z" }).eq("id", String(acc.id));
  }
  await postRiskAcceptanceSweep(R({}), env.db, "d", ops);

  // IC-06
  // NEGATIVE: an override with no rationale
  await postControlOverride(
    R({ control_id: "CG-VEL-01", subject_ref: "txn_1", actor_ref: "ops_1" }),
    env.db, "d", ops,
  );
  for (const n of [1, 2, 3]) {
    await postControlOverride(
      R({ control_id: "CG-VEL-01", subject_kind: "transfer", subject_ref: `txn_${n}`,
          actor_ref: "ops_1", rationale: "member instruction verified by phone" }),
      env.db, "d", ops,
    );
  }
  // NEGATIVE: an exception with no risk acceptance behind it
  await postControlException(
    R({ control_id: "CG-NSF-01", scope: "commercial members", rationale: "sweep arrangement",
        approver_id: "cco_1", registered_by: "ops_1",
        expires_at: "2026-12-31T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  // NEGATIVE: self-approved exception
  await postControlException(
    R({ control_id: "CG-NSF-01", scope: "commercial members", rationale: "sweep arrangement",
        approver_id: "ops_1", registered_by: "ops_1",
        expires_at: "2026-12-31T00:00:00.000Z", risk_acceptance_id: String(acc?.id ?? "") }),
    env.db, "d", ops,
  );
  await postControlException(
    R({ control_id: "CG-NSF-01", scope: "commercial members", rationale: "sweep arrangement",
        approver_id: "cco_1", registered_by: "ops_1",
        expires_at: "2026-08-01T00:00:00.000Z", risk_acceptance_id: String(acc?.id ?? "") }),
    env.db, "d", ops,
  );
  const exc = (env.rows["core.control_exception"] ?? [])[0];
  await postControlExceptionSweep(R({}), env.db, "d", ops);
  if (exc) {
    await env.db.schema("core").from("control_exception")
      .update({ expires_at: "2020-01-01T00:00:00.000Z" }).eq("id", String(exc.id));
  }
  await postControlExceptionSweep(R({}), env.db, "d", ops);
  await postOverrideAnalytics(R({ period: "2026Q3" }), env.db, "d", ops);
}

/**
 * The BSA/AML programme, driven end to end.
 *
 * CIP with all four elements and one missing them -> OFAC screens clean and
 * matched, hold placed and released -> EDD by category with senior sign-off ->
 * PEP hit opening its own EDD -> monetary instruments across all three bands ->
 * Travel Rule records present and absent -> CMIR filing -> FBAR aggregate ->
 * 314(a) request and response -> a GTO assessed -> escalations routed and
 * acknowledged -> SAR timer, continuing filing and a disclosure refusal.
 */
async function runBsaProgramLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.ofac_screen"] ?? []).length > 0) return;
  const ops = env.actors.ops;
  const officer = env.actors.officer;

  // CIP: complete, then one missing an element, then one that hits OFAC
  await postCipVerification(
    R({ entity_ref: "ent_cip1", name: "Alice Chen", dob: "1980-01-01",
        address: "1 Main St", id_number: "DL-1234", tin: "***-**-1234",
        entity_type: "person", risk_tier: "low" }),
    env.db, "d", ops,
  );
  await postCipVerification(
    R({ entity_ref: "ent_cip2", name: "Robert Ainsley (partial CIP)", dob: "1975-05-05" }),
    env.db, "d", ops,
  );
  await postCipVerification(
    R({ entity_ref: "ent_cip3", name: "Sokolov Holdings (SDN test)", dob: "1990-01-01",
        address: "2 Side St", id_number: "P-9" }),
    env.db, "d", ops,
  );

  // standalone screens, and a release
  await postOfacScreen(
    R({ subject_kind: "wire_beneficiary", subject_ref: "wb_1", name: "Clean Beneficiary" }),
    env.db, "d", ops,
  );
  await postOfacScreen(
    R({ subject_kind: "ach_counterparty", subject_ref: "cp_1", name: "SDN Trading" }),
    env.db, "d", ops,
  );
  // NEGATIVE: releasing with no determination
  await postOfacRelease(R({ released_by: "bsa_officer" }), "ofacs_ach_counterparty_cp_1",
    env.db, "d", officer);
  await postOfacRelease(
    R({ released_by: "bsa_officer", determination: "false positive; DOB and address differ" }),
    "ofacs_ach_counterparty_cp_1", env.db, "d", officer,
  );
  await postOfacAnnualReport(
    R({ reporting_year: 2026, filed_by: "bsa_officer" }), env.db, "d", officer,
  );

  // PEP: a clean screen and a hit that must open its own EDD
  await postPepScreen(R({ entity_ref: "ent_cip1", name: "Alice Chen" }), env.db, "d", ops);
  await postPepScreen(
    R({ entity_ref: "ent_pep1", name: "Foreign Minister", pep_category: "foreign_official" }),
    env.db, "d", ops,
  );

  // EDD: an ordinary category, then one needing senior sign-off
  await postEddProfile(
    R({ entity_ref: "ent_msb1", category: "msb", trigger_reason: "money services business" }),
    env.db, "d", ops,
  );
  await postEddCompletion(
    R({ findings: "licensed MSB, registration verified" }), "edd_ent_msb1_msb",
    env.db, "d", officer,
  );
  await postEddProfile(
    R({ entity_ref: "ent_corr1", category: "correspondent",
        trigger_reason: "foreign correspondent relationship" }),
    env.db, "d", ops,
  );
  // NEGATIVE: completing a senior-approval category without sign-off
  await postEddCompletion(
    R({ findings: "reviewed" }), "edd_ent_corr1_correspondent", env.db, "d", ops,
  );
  await postEddCompletion(
    R({ findings: "reviewed; Wolfsberg questionnaire on file", approved_by: "bsa_officer" }),
    "edd_ent_corr1_correspondent", env.db, "d", officer,
  );
  // and the PEP EDD the screen opened, completed with senior sign-off
  await postEddCompletion(
    R({ findings: "source of wealth documented", approved_by: "bsa_officer" }),
    "edd_ent_pep1_pep", env.db, "d", officer,
  );

  // monetary instruments: below the band, in the band, above it
  await postMonetaryInstrument(
    R({ instrument_type: "money_order", amount_cents: 50_000, purchaser_name: "Small Buyer" }),
    env.db, "d", ops,
  );
  // NEGATIVE: in the log band with no identification
  await postMonetaryInstrument(
    R({ instrument_type: "cashiers_check", amount_cents: 500_000,
        purchaser_name: "Anonymous Buyer" }),
    env.db, "d", ops,
  );
  await postMonetaryInstrument(
    R({ instrument_type: "cashiers_check", amount_cents: 500_000,
        purchaser_name: "Known Buyer", purchaser_ref: "ent_cip1",
        purchaser_id_type: "drivers_license", purchaser_id_number: "DL-1234",
        purchaser_dob: "1980-01-01" }),
    env.db, "d", ops,
  );
  await postMonetaryInstrument(
    R({ instrument_type: "bank_draft", amount_cents: 1_500_000, purchaser_name: "Large Buyer",
        purchaser_id_type: "passport", purchaser_id_number: "P-1" }),
    env.db, "d", ops,
  );

  // Travel Rule: a compliant wire and one missing its originator record. The
  // record now binds to a REAL wire at its real amount, so the wires must
  // exist first (real wire_transfer shape — see the EPS-06 fixture below).
  const [wTr1, wTr2, wTr3] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  for (const [id, amount] of [[wTr1, 500_000], [wTr2, 900_000], [wTr3, 100_000]] as const) {
    await env.db.schema("core").from("wire_transfer").upsert({
      id, partner_id: "ptnr_drill", amount,
      beneficiary: { name: "Bob Payee" }, status: "pending_approval",
    }, { onConflict: "id" });
  }
  await postTravelRuleRecord(
    R({ wire_ref: wTr1, amount_cents: 500_000,
        originator: { name: "Alice Chen", address: "1 Main St", account: "acct_1",
                      routing_number: "021000021", reference: "ref-1" },
        beneficiary: { name: "Bob Payee", account: "ext_9" } }),
    env.db, "d", ops,
  );
  await postTravelRuleRecord(
    R({ wire_ref: wTr2, amount_cents: 900_000, beneficiary: { name: "Bob Payee" } }),
    env.db, "d", ops,
  );
  // below the threshold nothing attaches
  await postTravelRuleRecord(
    R({ wire_ref: wTr3, amount_cents: 100_000 }), env.db, "d", ops,
  );

  // CMIR — the shipment register is built by cash operations. Seed it
  // through the DATABASE, not by pushing into env.rows: the recording array
  // is only a mirror of the fake, and a row planted there never exists in
  // Postgres — live, the filing 404s and BSA-12 produces nothing (fixture
  // mutation, fake-vs-real defect class 7). The cmir_filing row's FK means
  // the border-crossing cash_shipment must exist FIRST (FKs are enforced
  // only in Postgres — defect class 1). Run-unique ids, demo provenance:
  // a drill fixture must not masquerade as production evidence.
  const shipId = `cmir_ship_${env.n()}`;
  await env.db.schema("core").from("cash_shipment").insert({
    id: `cship_intl_${shipId}`, direction: "outbound", amount_cents: 4_500_000,
    seal_expected: "SEAL-77", crosses_border: true, provenance: "demo",
  });
  await env.db.schema("core").from("cmir_filing").insert({
    id: shipId, shipment_id: `cship_intl_${shipId}`, amount_cents: 4_500_000,
    identified_at: "2026-07-01T00:00:00.000Z", provenance: "demo",
  });
  await postCmirFiling(
    R({ filed_by: "bsa_officer", fincen_ref: "F105-2026-1" }), shipId,
    env.db, "d", officer,
  );

  // a NIL year: no foreign accounts, and the determination is still recorded
  await postFbarFiling(R({ reporting_year: 2025 }), env.db, "d", officer);

  // FBAR: two accounts that individually are under the threshold and together
  // are over it
  for (const [ref, val] of [["fa_1", 600_000], ["fa_2", 700_000]]) {
    await postFbarAccount(
      R({ account_ref: ref, country: "CH", institution_name: "Alpine Bank",
          max_value_cents: val, reporting_year: 2026 }),
      env.db, "d", ops,
    );
  }
  await postFbarFiling(
    R({ reporting_year: 2026, filed_by: "bsa_officer", bsa_efiling_ref: "FBAR-2026-1" }),
    env.db, "d", officer,
  );

  // 314(a)
  await post314aRequest(
    R({ reference: "314A-2026-07", received_at: "2026-07-10T00:00:00.000Z" }), env.db, "d", ops,
  );
  // NEGATIVE: responding with no match count
  await post314aResponse(
    R({ responded_by: "bsa_officer" }), "filing_314a_314A-2026-07", env.db, "d", officer,
  );
  await post314aResponse(
    R({ match_count: 0, responded_by: "bsa_officer" }), "filing_314a_314A-2026-07",
    env.db, "d", officer,
  );

  // a GTO, assessed for applicability
  await postRegulatoryChange(
    R({ kind: "gto", reference: "GTO-2026-REALESTATE", issued_by: "FinCEN",
        effective_at: "2026-08-01T00:00:00.000Z",
        applicability: "not applicable — no title insurance business",
        assessed_by: "bsa_officer", controls_updated: [] }),
    env.db, "d", officer,
  );

  // escalations
  await postEscalation(
    R({ source_kind: "bsa_alert", source_ref: "alert_1", severity: "urgent",
        routed_to: "bsa_officer" }),
    env.db, "d", ops,
  );
  const esc = (env.rows["core.escalation"] ?? [])[0];
  await postEscalationAck(
    R({ acknowledged_by: "bsa_officer", disposition: "escalated to SAR committee",
        action_plan: "file SAR within 30 days; review related accounts" }),
    String(esc?.id ?? "x"), env.db, "d", officer,
  );

  // SAR lifecycle: the timer, a continuing filing, and a disclosure refusal.
  // Against a REAL case — the handler now refuses ids that don't exist.
  const sarCase = `case_bsa1_${env.n()}`;
  await env.db.schema("core").from("case").upsert({
    id: sarCase, type: "investigation", status: "opened",
    opened_at: new Date().toISOString(), opened_by: "tok_inv_1", provenance: "demo",
  }, { onConflict: "id" });
  await postSarLifecycle(R({ stage: "timer" }), sarCase, env.db, "d", officer);
  await postSarLifecycle(
    R({ stage: "continuing", filed_by: "bsa_officer", fincen_ref: "SAR-2026-2" }),
    sarCase, env.db, "d", officer,
  );
  await postSarLifecycle(
    R({ stage: "disclosure_request", requester: "subject's attorney" }),
    sarCase, env.db, "d", officer,
  );

  // BSA-08: a CTR aggregation that reaches the threshold is FILED. The
  // aggregation writer exists; nothing was calling the filing step.
  //
  // The business_date must be RUN-UNIQUE: uq_ctr_entity_date means a fixed
  // date makes every live run after the first a duplicate — the upsert
  // no-ops, this run's recording never sees a ctr_filing row, and the filing
  // step silently never fires (green in the fake, which starts empty).
  const cn = env.n();
  const ctrDate = `${2000 + (cn % 40)}-${String(1 + Math.floor(cn / 40) % 12).padStart(2, "0")}-${
    String(1 + Math.floor(cn / 480) % 28).padStart(2, "0")
  }`;
  await postCashTransaction(
    R({ direction: "cash_in", amount_cents: 1_200_000, business_date: ctrDate,
        account_id: "acct_1" }),
    env.db, "d", ops,
  );
  const ctr = (env.rows["core.ctr_filing"] ?? [])[0];
  if (ctr) {
    await postCtrFile(
      R({ filed_by: "bsa_officer", fincen_ref: "CTR-2026-1" }), String(ctr.id),
      env.db, "d", officer,
    );
  }

  // BSA-06: a case decided NOT to file is a decision with its own evidence.
  // "no SAR filed" and "nobody decided" must not look alike.
  //
  // Run-unique causeId: the alert id derives from it, and a fixed id means
  // every live run after the first finds the alert already triaged — the
  // triage replies without a case, the no_file decision is never posted,
  // and sar.decision_no_file quietly vanishes from the run's evidence.
  const nf = env.n();
  await raiseAlert(env.db, {
    ctx: ops, alertType: "structuring", entityHash: "h_nofile",
    causeType: "transfer", causeId: `t_nofile_${nf}`, details: "bsa program drill",
  });
  const tri = await postAlertTriage(
    R({ outcome: "escalated" }), `alert_t_nofile_${nf}_structuring`, env.db, "d",
    env.actors.investigator,
  );
  const tb = await tri.clone().json().catch(() => ({}));
  if (tb?.case?.id) {
    await postCaseDecision(
      R({ decision: "no_file", rationale: "activity explained by verified payroll" }),
      tb.case.id, env.db, "d", officer,
    );
  }

  await postCtrExemptionReview(
    R({ entity_ref: "ent_msb1", decision: "retained", reviewed_by: "bsa_officer",
        eligibility_reverified: true }),
    env.db, "d", officer,
  );
}

/**
 * The privacy programme, driven end to end.
 *
 * Notice published and delivered (including an E-SIGN delivery refused for
 * want of demonstrated consent) -> opt-outs set, cleared and PROPAGATED ->
 * state privacy requests with verification refused first -> web consent with a
 * GPC signal overriding the banner -> tag review -> an analytics dataset over
 * the re-identification threshold -> biometrics without consent, then with ->
 * age gate -> a furnishing dispute corrected and propagated.
 *
 * PR-03, PR-04 and PR-15 are absent on purpose: vendor attestations, outside
 * counsel and third-party connection telemetry are not facts this core holds.
 */
async function runPrivacyLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.privacy_notice"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  await postPrivacyNotice(
    R({ version: "v3", template_ref: "tpl-3", material_change: true,
        effective_at: "2026-01-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  await postNoticeDelivery(
    R({ entity_ref: "ent_p1", reason: "annual", channel: "mail" }),
    "pnotice_v3", env.db, "d", ops,
  );
  // NEGATIVE: electronic delivery with no E-SIGN consent
  await postNoticeDelivery(
    R({ entity_ref: "ent_p2", reason: "annual", channel: "esign" }),
    "pnotice_v3", env.db, "d", ops,
  );
  // NEGATIVE: consent that did not demonstrate access
  await postEsignConsent(
    R({ entity_ref: "ent_p2", demonstrated_access: false }), env.db, "d", ops,
  );
  await postEsignConsent(
    R({ entity_ref: "ent_p3", demonstrated_access: true }), env.db, "d", ops,
  );
  await postNoticeDelivery(
    R({ entity_ref: "ent_p3", reason: "member_request", channel: "esign",
        esign_consent_id: "esign_ent_p3" }),
    "pnotice_v3", env.db, "d", ops,
  );

  // opt-outs: set, Nevada, and one cleared
  await postPrivacyPreference(
    R({ entity_ref: "ent_p1", channel: "nonaffiliate_sharing", opted_out: true,
        source: "member_request", entity_jurisdiction: "CA" }),
    env.db, "d", ops,
  );
  await postPrivacyPreference(
    R({ entity_ref: "ent_p1", channel: "nevada_sale", opted_out: true,
        source: "member_request" }),
    env.db, "d", ops,
  );
  await postPrivacyPreference(
    R({ entity_ref: "ent_p3", channel: "marketing", opted_out: false,
        source: "member_request" }),
    env.db, "d", ops,
  );
  // NEGATIVE: propagation naming no systems
  await postPreferencePropagation(R({ systems: [] }), env.db, "d", ops);
  await postPreferencePropagation(
    R({ systems: ["core", "marketing_platform", "data_warehouse"] }), env.db, "d", ops,
  );

  // state rights
  await postStateRequest(
    R({ entity_ref: "ent_p1", state: "CA", right_requested: "access",
        received_at: "2026-07-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  // NEGATIVE: fulfilling before the requester is verified
  await postStateRequestFulfilment(
    R({ verified: false, outcome: "fulfilled" }), "psreq_ent_p1_access", env.db, "d", ops,
  );
  await postStateRequestFulfilment(
    R({ verified: true, outcome: "fulfilled" }), "psreq_ent_p1_access", env.db, "d", ops,
  );
  // an opt-out right sets the standing state, not just a ticket
  await postStateRequest(
    R({ entity_ref: "ent_p4", state: "NV", right_requested: "opt_out" }), env.db, "d", ops,
  );

  // web: a tag reviewed, then consent with GPC overriding the banner
  await postWebTagReview(
    R({ vendor: "Analytics Co", category: "analytics", decision: "approved",
        reviewed_by: "privacy_officer" }),
    env.db, "d", ops,
  );
  await postWebTagReview(
    R({ vendor: "Ad Network", category: "advertising", decision: "rejected",
        reviewed_by: "privacy_officer" }),
    env.db, "d", ops,
  );
  await postWebConsent(
    R({ session_ref: "sess_1", categories: { analytics: true, advertising: true } }),
    env.db, "d", ops,
  );
  await postWebConsent(
    R({ session_ref: "sess_2", gpc_signal: true,
        categories: { analytics: true, advertising: true } }),
    env.db, "d", ops,
  );

  // analytics: one released, one over the re-identification threshold
  await postAnalyticsDataset(
    R({ purpose: "branch demand model", requested_by: "analytics_1",
        method: "k_anonymity", k_value: 20, reid_risk_bp: 100, risk_threshold_bp: 500 }),
    env.db, "d", ops,
  );
  await postAnalyticsDataset(
    R({ purpose: "member churn raw", requested_by: "analytics_1",
        method: "aggregation", reid_risk_bp: 900, risk_threshold_bp: 500 }),
    env.db, "d", ops,
  );
  // NEGATIVE: k-anonymity with no k
  await postAnalyticsDataset(
    R({ purpose: "no k", requested_by: "analytics_1", method: "k_anonymity" }),
    env.db, "d", ops,
  );

  // biometrics: refused without consent, then captured and purged
  await postBiometricVerification(R({ entity_ref: "ent_p5" }), env.db, "d", ops);
  await postBiometricVerification(
    R({ entity_ref: "ent_p5", consent_id: "bioconsent_1", outcome: "verified" }),
    env.db, "d", ops,
  );
  await postBiometricVerification(
    R({ entity_ref: "ent_p6", consent_id: "bioconsent_2", outcome: "declined" }),
    env.db, "d", ops,
  );
  // backdate the purge clock THROUGH the client — mutating the recorded copy
  // leaves the live row undue, and the purge sweep finds nothing (PR-16's
  // original fake-vs-real defect)
  const bio = (env.rows["core.biometric_verification"] ?? [])[0];
  if (bio) {
    await env.db.schema("core").from("biometric_verification")
      .update({ purge_due_at: "2020-01-01T00:00:00.000Z" }).eq("id", String(bio.id));
  }
  await postBiometricPurge(R({}), env.db, "d", ops);

  // children's data
  await postMinorDataEvent(
    R({ kind: "age_gate_blocked", subject_ref: "sub_1", age_asserted: 11 }), env.db, "d", ops,
  );
  await postMinorDataEvent(
    R({ kind: "minor_data_detected", subject_ref: "sub_2", age_asserted: 10 }), env.db, "d", ops,
  );
  await postMinorDataEvent(
    R({ kind: "deleted", subject_ref: "sub_2" }), env.db, "d", ops,
  );

  // corrections
  await postFurnishingDispute(
    R({ entity_ref: "ent_p1", field: "address", disputed_value: "old address",
        redflag: true, ncoa_candidate: "1 New St", ncoa_mismatch: true,
        dispute_basis: "data_accuracy",
        received_at: "2026-07-01T00:00:00.000Z" }),
    env.db, "d", ops,
  );
  await postFurnishingCorrection(
    R({ corrected_value: "1 New St", systems: ["core", "bureau_feed"] }),
    "fdisp_ent_p1_address", env.db, "d", ops,
  );

  // disposal and the incident notification decision
  await postDisposalCertificate(
    R({ record_ref: "rec_p1", method: "shredded", certificate_ref: "cert-p1",
        approved_by: "records_officer" }),
    env.db, "d", ops,
  );
  await postNotificationDecision(
    R({ decision: "notify", rationale: "member NPPI exposed", sar_referred: true,
        description: "unencrypted export of member records",
        detection_source: "dlp_alert", data_scope: ["name", "account_number"],
        scope_initial: ["name", "account_number"], material: true }),
    "inc_p1", env.db, "d", ops,
  );
}

/** Collections, driven end to end. Delinquency derived at four thresholds,
 * classification and nonaccrual, a workout refused for self-approval and a
 * re-age refused for exceeding its limit, the FDCPA contact gate blocking on
 * each protection, furnishing, and an overdraft charged off at 45 days. */
async function runCollectionsLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.delinquency_evaluation"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  await postCollectionsPolicy(
    R({ version: "col-v2", approved_by: "board-2026-03", scope: "all consumer loans",
        agencies: ["Northgate Recovery"] }),
    env.db, "d", ops,
  );

  // through the client, NOT env.rows: the delinquency engine READS these
  // loans back from the database — a loan pushed only into the recorder does
  // not exist on the live tier, and the whole collections lifecycle 404s
  // (CO-01/02/03/05/09's original fake-vs-real defect). No provenance on
  // core.account: the table predates the provenance convention.
  await env.db.schema("core").from("entity").upsert(
    { id: "ent_dec", type: "person", name: "Harold Payne (deceased)", status: "active", partner_id: "ptnr_drill" },
    { onConflict: "id" },
  );
  await env.db.schema("core").from("account").upsert({
    id: "acct_estate", entity_id: "ent_dec", status: "open", account_type: "checking",
    balance: 0, partner_id: "ptnr_drill", death_flag: true,
  }, { onConflict: "id" });
  for (const [id, due] of [
    ["loan_c1", "2026-07-05"],   // ~14 days past due
    ["loan_c2", "2026-04-01"],   // ~109 days
    ["loan_c3", "2026-01-01"],   // ~199 days
    ["loan_current", "2026-08-01"],
  ]) {
    await env.db.schema("core").from("loan").upsert({
      id, member_ref: `mbr_${id}`, product: "consumer", principal_cents: 500_000,
      next_due_date: due, attorney_represented: false, bankruptcy_flag: false,
      scra_flag: false, product_type: "closed_end_consumer", grace_period_days: 10,
      last_payment_date: "2026-06-01", collateral_value: 800_000, ltv: 6250,
      accrued_interest: 12_000, provenance: "production",
    }, { onConflict: "id" });
  }
  // NEGATIVE: a loan with no due date cannot be evaluated
  await env.db.schema("core").from("loan").upsert({
    id: "loan_nodue", member_ref: "mbr_x", product: "consumer",
    principal_cents: 1000, provenance: "production",
  }, { onConflict: "id" });

  for (const id of ["loan_c1", "loan_c2", "loan_c3", "loan_current", "loan_nodue"]) {
    await postDelinquencyEvaluation(
      R({ well_secured_documented: true, collectibility_assessment: "full recovery expected",
          repayment_evidence: "three payments since workout",
          entity_contact: { phone: "+15550123" },
          past_due_amount: 45_000,
          workout_alternatives: ["forbearance", "extension"],
          bankruptcy_case_id: "BK-2026-77", estate_claim_status: "no claim filed",
          estimated_recovery: 300_000 }),
      id, env.db, "d", ops,
    );
  }
  // a nonaccrual loan brought CURRENT comes back on accrual — updated through
  // the client so the LIVE database sees the cure, not just the recorder
  await env.db.schema("core").from("loan")
    .update({ next_due_date: "2026-09-01" }).eq("id", "loan_c2");
  await postDelinquencyEvaluation(R({}), "loan_c2", env.db, "d", ops);
  await postChargeOff(
    R({ approved_by: "cco_1", amount_cents: 500_000,
        foreclosure_impact_eval: "collateral covers 80% of balance" }),
    "loan_c3", env.db, "d", ops,
  );

  // workouts
  await postLoanModification(
    R({ kind: "forbearance", borrower_hardship: true, concession_granted: true,
        requested_by: "collector_1", approved_by: "manager_1",
        payments_received_after_mod: true,
        proposed_modification: { new_rate_bp: 500, term_months: 60 }, io_term_months: 12 }),
    "loan_c2", env.db, "d", ops,
  );
  // NEGATIVE: self-approved
  await postLoanModification(
    R({ kind: "extension", borrower_hardship: false, concession_granted: false,
        requested_by: "collector_1", approved_by: "collector_1" }),
    "loan_c1", env.db, "d", ops,
  );
  await postLoanModification(
    R({ kind: "reage", borrower_hardship: true, concession_granted: false,
        requested_by: "collector_1", approved_by: "manager_1" }),
    "loan_c1", env.db, "d", ops,
  );
  // NEGATIVE: a second re-age within twelve months
  await postLoanModification(
    R({ kind: "reage", borrower_hardship: true, concession_granted: false,
        requested_by: "collector_1", approved_by: "manager_1" }),
    "loan_c1", env.db, "d", ops,
  );

  // FDCPA gate: permitted, then blocked on each protection in turn
  await postCollectionContact(
    R({ channel: "phone", local_hour: 14, member_ref: "mbr_loan_c1" }),
    "loan_c1", env.db, "d", ops,
  );
  await postCollectionContact(
    R({ channel: "phone", local_hour: 6, member_ref: "mbr_loan_c1" }),
    "loan_c1", env.db, "d", ops,
  );
  await postCollectionProtection(
    R({ attorney_represented: true, attorney_ref: "Smith LLP",
        template_ref: "tpl-dunning-1", template_approved_by: "compliance_1" }),
    "loan_c2", env.db, "d", ops,
  );
  await postCollectionContact(
    R({ channel: "phone", local_hour: 14, member_ref: "mbr_loan_c2" }),
    "loan_c2", env.db, "d", ops,
  );
  await postCollectionProtection(R({ cease: true }), "loan_c3", env.db, "d", ops);
  await postCollectionContact(
    R({ channel: "sms", local_hour: 12, member_ref: "mbr_loan_c3" }),
    "loan_c3", env.db, "d", ops,
  );

  await postFurnishingCycle(
    R({ period: "2026-07", attested_by: "collections_manager", disputes_investigated: 2,
        corrections: 1, disputes_resolved: 2, idtheft_disputes: 1,
        dispute_category: "identity_theft", idtheft_report: "FTC-2026-114" }),
    env.db, "d", ops,
  );

  // CO-11: a collections-data incident goes through the SAME incident
  // machinery, with its own scope fields.
  await postIncident(
    R({ id: "inc_drill_collections", title: "collections vendor file exposure", severity: "sev2",
        source: "vendor_report", description: "agency emailed an unencrypted file",
        detection_source: "vendor_report", data_scope: ["name", "balance"],
        collections: true }),
    env.db, "d", ops,
  );
  // the assessment must PRECEDE the determination
  // (ck_incident_assessment_before_determination) — determining an unassessed
  // incident is the row the schema refuses, and it read as CO-11's defect
  await postIncidentAssessment(
    R({ data_scope: { members: 0, fields: ["name", "balance"] },
        member_impact: "none confirmed",
        facts: { vector: "vendor email", contained: true },
        scope_initial: "single unencrypted file", detection_source: "vendor_report" }),
    "inc_drill_collections", env.db, "d", ops,
  );
  await postDetermineReportability(
    R({ is_reportable: false, rationale: "no member NPPI beyond name and balance",
        assessment: "reviewed against 12 CFR 748 App B; no sensitive identifiers exposed" }),
    "inc_drill_collections", env.db, "d",
    { ...ops, tokenId: "tok_comp", roles: ["bsa_compliance"] },
  );

  await postOverdraftReferral(
    R({ account_ref: "acct_od1", balance_cents: -25_000, days_negative: 20,
        fees_assessed_cents: 3_000 }),
    env.db, "d", ops,
  );
  // NEGATIVE: a waiver with no approver
  await postOverdraftReferral(
    R({ account_ref: "acct_od2", balance_cents: -12_000, days_negative: 10,
        fees_assessed_cents: 3_000, fees_waived_cents: 3_000 }),
    env.db, "d", ops,
  );
  await postOverdraftReferral(
    R({ account_ref: "acct_od3", balance_cents: -40_000, days_negative: 50,
        fees_assessed_cents: 6_000, fees_waived_cents: 3_000,
        waiver_approved_by: "branch_manager" }),
    env.db, "d", ops,
  );
}

/** Truth in Savings, member lifecycle and the fair-lending gaps. */
async function runDepositsMemberLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.disclosure_template"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  for (const kind of [
    "account_opening", "change_in_terms", "maturity", "periodic_statement",
    "overdraft_service", "valuation_rights", "appraisal_copy",
  ]) {
    await postDisclosureTemplate(
      R({ kind, version: "v1", content_ref: `ref-${kind}`, approved_by: "compliance_1",
          product_scope: "share_savings", advertising_medium: "branch_poster",
          advertising_approval_id: "adv_1" }),
      env.db, "d", ops,
    );
  }
  // a deliverable address is a precondition of a mailed disclosure
  await env.db.schema("core").from("address").upsert({
    id: "addr_d1", entity_ref: "ent_m1", line1: "1 Main St", city: "Durham",
    region: "NC", postal_code: "27701", provenance: "production",
  }, { onConflict: "id" });
  await env.db.schema("core").from("esign_consent").upsert({
    id: "esign_d1", entity_ref: "ent_m1", started_at: "2026-07-19T12:00:00.000Z",
    captured_at: "2026-07-19T12:00:00.000Z", demonstrated_access: true, provenance: "production",
  }, { onConflict: "id" });
  // the entity must exist first (fk_account_entity is real on the live tier),
  // the partner is the seeded one, and core.account has no provenance column
  await env.db.schema("core").from("entity").upsert(
    { id: "ent_m1", type: "person", name: "Mia Lawson", status: "active", partner_id: "ptnr_drill" },
    { onConflict: "id" },
  );
  await env.db.schema("core").from("account").upsert({
    id: "acct_d1", entity_id: "ent_m1", status: "open", account_type: "certificate",
    balance: 0, partner_id: "ptnr_drill", opening_channel: "branch",
    maturity_date: "2027-07-19", maturity_window: "10_day_grace",
    maturity_disposition: "auto_renew",
  }, { onConflict: "id" });
  const terms = {
    account_type: "certificate", opening_channel: "branch",
    account_restriction: "none", address_id: "addr_d1", esign_consent_id: "esign_d1",
    interest_config_id: "picfg_share_savings", rate_bp: 200, compounding: "daily",
    maturity_date: "2027-07-19", maturity_window: "10_day_grace",
    maturity_disposition: "auto_renew", failure_reason: null,
  };
  for (const [kind, extra] of [
    ["account_opening", {}], ["change_in_terms", { adverse: true }],
    ["maturity", {}], ["valuation_rights", {}], ["appraisal_copy", {}],
  ] as Any[]) {
    await postDisclosureDelivery(
      R({ kind, member_ref: "mbr_d1", account_ref: "acct_d1", channel: "esign",
          trigger_event: "drill", template_id: `dtpl_${kind}_v1`, ...terms, ...extra }),
      env.db, "d", ops,
    );
  }
  // NEGATIVE: electronic delivery with no captured E-SIGN consent is refused
  await postDisclosureDelivery(
    R({ kind: "account_opening", member_ref: "mbr_d9", channel: "esign",
        trigger_event: "drill" }),
    env.db, "d", ops,
  );
  await postBalanceInquiry(
    R({ balance_cents: 1_050_000, held_cents: 20_000, channel: "atm" }),
    "acct_d1", env.db, "d", ops,
  );
  // NEGATIVE: a delivery with a detected error must say what was wrong
  await postDisclosureDelivery(
    R({ kind: "account_opening", member_ref: "mbr_d2", trigger_event: "drill",
        error_detected: true }),
    env.db, "d", ops,
  );
  await postDisclosureDelivery(
    R({ kind: "account_opening", member_ref: "mbr_d2", trigger_event: "drill",
        error_detected: true, error_detail: "wrong APY printed" }),
    env.db, "d", ops,
  );

  await postInterestConfig(
    R({ product_code: "share_savings", rate_bp: 200, compounding: "daily",
        balance_method: "daily_balance" }),
    env.db, "d", ops,
  );
  const cfg = (env.rows["core.product_interest_config"] ?? [])[0];
  // NEGATIVE: accruing with no configuration
  await postInterestAccrualRun(R({ period: "2026-07", config_id: "nope" }), env.db, "d", ops);
  await postInterestAccrualRun(
    R({ period: "2026-07", config_id: String(cfg?.id ?? ""),
        accounts: [{ balance_cents: 1_000_000 }, { balance_cents: 500_000 }] }),
    env.db, "d", ops,
  );
  await postStatement(
    R({ account_ref: "acct_d1", period: "2026-07", opening_balance_cents: 1_000_000,
        closing_balance_cents: 1_050_000, interest_paid_cents: 1_600,
        fees_ytd_cents: 4_500, overdraft_fees_ytd_cents: 3_000 }),
    env.db, "d", ops,
  );

  await postMembership(
    R({ entity_ref: "ent_m1", eligibility_basis: "employer group", eligible: true,
        account_type: "savings" }),
    env.db, "d", ops,
  );
  // NEGATIVE: a denial with no basis
  await postMembership(R({ entity_ref: "ent_m2", eligible: false }), env.db, "d", ops);
  await postMembership(
    R({ entity_ref: "ent_m2", eligible: false, denial_reason: "outside the field of membership" }),
    env.db, "d", ops,
  );
  await postAddressChange(
    R({ old_address: { line1: "1 Old St" }, new_address: { line1: "2 New Ave" },
        card_requested: true }),
    "mbr_ent_m1", env.db, "d", ops,
  );
  // MP-02: the reissue arrives while the address hold is still open
  await postCardReissue(
    R({ ship_to_address_id: "addr_d1" }), "mbr_ent_m1", env.db, "d", ops,
  );
  await postMemberPreferences(
    R({ channels: { email: true, sms: false }, reverted: true,
        revert_reason: "email bounced" }),
    "mbr_ent_m1", env.db, "d", ops,
  );
  await postMemberRestriction(
    R({ restriction: "deposit_only", reason: "repeated NSF activity",
        account_ref: "acct_d1", balance_cents: 1_050_000,
        contact: { email: "m1@example.test", phone: "555-0100" },
        amounts_owed_cents: 3_500 }),
    "mbr_ent_m1", env.db, "d", ops,
  );
  await postMemberRestriction(
    R({ restriction: "frozen", reason: "account closure", close: true, payout_cents: 25_000 }),
    "mbr_ent_m2", env.db, "d", ops,
  );
  // NEGATIVE: a bulk export with no stated purpose
  await postMemberRecordExport(R({ record_count: 5000 }), "mbr_ent_m1", env.db, "d", ops);
  await postMemberRecordExport(
    R({ purpose: "examiner request 2026-3", record_count: 5000, requested_by: "compliance_1" }),
    "mbr_ent_m1", env.db, "d", ops,
  );
  await postServiceRequest(
    R({ channel: "phone", received_at: "2026-07-01T00:00:00.000Z", resolved: true }),
    "mbr_ent_m1", env.db, "d", ops,
  );

  // fair lending gaps
  await postLoCompPlan(
    R({ originator_ref: "lo_1", basis: "flat per loan", varies_with_terms: false,
        decided_by: "cco_1" }),
    env.db, "d", ops,
  );
  // NEGATIVE: compensation that varies with the terms cannot be approved
  await postLoCompPlan(
    R({ originator_ref: "lo_2", basis: "share of rate spread", varies_with_terms: true,
        decided_by: "cco_1" }),
    env.db, "d", ops,
  );
  for (const a of ["app_fl1", "app_fl2"]) {
    await env.db.schema("core").from("loan_application").upsert({
      id: a, status: "completed", funding_block_state: "open", provenance: "production",
    }, { onConflict: "id" });
  }
  await postApplicationIntake(
    R({ channel: "branch", product_type: "purchase_first_lien", applicant_state: "NC",
        geography: "37063000101" }),
    "app_fl1", env.db, "d", ops,
  );
  await postApplicationOptions(
    R({ options_presented: ["lowest_rate", "lowest_rate_no_risky", "lowest_total_cost"],
        waiver_decision: "not_waived", disclosures: ["loan_estimate"],
        final_action: "approved" }),
    "app_fl1", env.db, "d", ops,
  );
  await postGmiCollection(
    R({ gmi: { ethnicity: "not_provided", race: "not_provided", sex: "not_provided" },
        hmda_reportable: true }),
    "app_fl1", env.db, "d", ops,
  );
  // NEGATIVE: incomplete GMI on a reportable application opens a finding
  await postGmiCollection(
    R({ gmi: { ethnicity: "not_provided" }, hmda_reportable: true }), "app_fl2", env.db, "d", ops,
  );
  await postNoticeQueue(R({ kind: "incompleteness", oral: true }), "app_fl2", env.db, "d", ops);
  await postLendingAdverseAction(
    R({ reasons: ["insufficient deposit history"], reviewed_by: "compliance_1",
        subject_kind: "account", account_ref: "acct_d1", applicant_state: "NC",
        business_revenue_tier: "under_1m", score_block: { model: "v3", score: 610 },
        party_identity: "verified_documentary", incompleteness_notice: true,
        counteroffer_terms: { rate_bp: 850 }, oral_statement: "reasons given by phone",
        oral: true }),
    "app_fl2", env.db, "d", ops,
  );
  // NEGATIVE: fewer than three options must say why, rather than passing quietly
  await postApplicationOptions(
    R({ options_presented: ["lowest_rate"], final_action: "denied" }),
    "app_fl2", env.db, "d", ops,
  );
}

/** E-commerce: policy, enrollment, credentials, transaction audit trail. */
async function runEcommerceLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.member_credential"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  await postEcommerceRiskAssessment(
    R({ document_version: "v3", finding_description: "two medium findings on session timeout",
        control_register: ["EC-03", "EC-04", "EC-07"],
        regulatory_change_analysis: "no material change since v2",
        board_approved_by: "board_chair" }),
    env.db, "d", ops,
  );
  // NEGATIVE: board approval ahead of the assessment it approves against
  await postEcommerceRiskAssessment(
    R({ document_version: "v4", completed: false, board_approved_by: "board_chair" }),
    env.db, "d", ops,
  );

  // NEGATIVE: an enrollment whose member-number comparison has no answer
  await postEnrollment(
    R({ member_ref: "mbr_e9", channel: "web", applicant_identity: "A. Nonymous",
        verified: true }),
    env.db, "d", ops,
  );
  // NEGATIVE: a verification denial
  await postEnrollment(
    R({ member_ref: "mbr_e8", channel: "phone", applicant_identity: "Wrong Person",
        member_number_match: false, verified: false,
        denial_reason: "member number does not match the name on file" }),
    env.db, "d", ops,
  );
  await postEnrollment(
    R({ member_ref: "mbr_e1", channel: "web", applicant_identity: "Real Member",
        identity_evidence: { doc: "drivers_licence", provider: "sim" },
        member_number_match: true, entity_email: "m1@example.test", verified: true }),
    env.db, "d", ops,
  );

  await postCredentialIssue(
    R({ member_ref: "mbr_e1", login_id: "member1", security_questions: ["q1", "q2"] }),
    env.db, "d", ops,
  );
  await postPasswordChange(R({ new_password: "correct-horse" }), "cred_mbr_e1", env.db, "d", ops);
  for (let i = 0; i < 5; i++) {
    await postLoginFailure(R({}), "cred_mbr_e1", env.db, "d", ops);
  }

  await postEcommerceTransaction(
    R({ member_ref: "mbr_e1", transaction_type: "transfer", amount_cents: 250_000,
        initiated_by: "mbr_e1", source_ip: "203.0.113.7", device: "ios",
        session_ref: "sess_1" }),
    env.db, "d", ops,
  );
  // NEGATIVE: a transaction with no recorded initiator cannot answer a claim
  await postEcommerceTransaction(
    R({ member_ref: "mbr_e1", transaction_type: "transfer", amount_cents: 100 }),
    env.db, "d", ops,
  );
  const tx = (env.rows["core.ecommerce_transaction"] ?? [])[0];
  if (tx) {
    // NEGATIVE: an outcome with no rationale discards the member's word silently
    await postRepudiationReview(R({ outcome: "rejected" }), String(tx.id), env.db, "d", ops);
    await postRepudiationReview(
      R({ outcome: "rejected", rationale: "audit trail shows the member's own device and session" }),
      String(tx.id), env.db, "d", ops,
    );
  }
}

/** Liquidity: bands, positions, mismatch, stress, collateral, packs. */
async function runLiquidityLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.liquidity_position"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  // NEGATIVE: a position with NO configured bands reports unassessed
  await postLiquidityPosition(
    R({ as_of_date: "2026-07-16", liquid_assets_cents: 40_000_000_00,
        total_assets_cents: 400_000_000_00, haircut_table: { treasury: 0, agency: 200 },
        gl_balances: { cash: 1 } }),
    env.db, "d", ops,
  );
  // NEGATIVE: bands that cross are not bands
  await postLarBandConfig(
    R({ critical_bp: 900, warning_bp: 500, target_bp: 1200, approved_by: "alco_chair" }),
    env.db, "d", ops,
  );
  await postLarBandConfig(
    R({ critical_bp: 500, warning_bp: 800, target_bp: 1200, approved_by: "alco_chair" }),
    env.db, "d", ops,
  );
  await postLiquidityPosition(
    R({ as_of_date: "2026-07-17", liquid_assets_cents: 40_000_000_00,
        total_assets_cents: 400_000_000_00, haircut_table: { treasury: 0, agency: 200 },
        gl_balances: { cash: 1 },
        behavioral_assumptions: { core_deposit_runoff_bp: 500 } }),
    env.db, "d", ops,
  );
  // a band CHANGE, and a critical breach
  await postLiquidityPosition(
    R({ as_of_date: "2026-07-18", liquid_assets_cents: 12_000_000_00,
        total_assets_cents: 400_000_000_00, haircut_table: { treasury: 0 },
        gl_balances: { cash: 1 } }),
    env.db, "d", ops,
  );

  // NEGATIVE: gaps with no limit configured -> unassessed, no breach
  await postMaturityMismatch(
    R({ gaps: { "0_30d": -90_000_000_00 }, gl_balances: { cash: 1 } }),
    "liqpos_2026-07-17", env.db, "d", ops,
  );
  await postMaturityMismatch(
    R({ gaps: { "0_30d": -90_000_000_00, "31_90d": -10_000_000_00 },
        limit: { "0_30d": -50_000_000_00, "31_90d": -50_000_000_00 },
        intraday: true, draw_amount_cents: 20_000_000_00,
        shortfall_estimate_cents: 40_000_000_00,
        gl_balances: { cash: 1 },
        behavioral_assumptions: { runoff_bp: 500 },
        disposition: "drew on the FHLB line and re-laddered", dispositioned_by: "treasurer_1" }),
    "liqpos_2026-07-18", env.db, "d", ops,
  );

  await postStressAssumptions(
    R({ set: "baseline", behavioral_assumptions: { runoff_bp: 500 },
        baas_shock_params: { partner_exit: true }, intraday_profile: { peak_hour: 14 },
        assumption_value: { runoff_bp: 500 } }),
    env.db, "d", ops,
  );
  // NEGATIVE: a changed assumption with no rationale or approver
  await postStressAssumptions(
    R({ set: "severe", behavioral_assumptions: { runoff_bp: 1500 } }), env.db, "d", ops,
  );
  await postStressAssumptions(
    R({ set: "severe", behavioral_assumptions: { runoff_bp: 1500 },
        assumption_value: { runoff_bp: 1500 },
        rationale: "March BaaS partner exit showed 15% runoff, not 5%",
        approver_id: "alco_chair" }),
    env.db, "d", ops,
  );
  await postStressRun(
    R({ period: "2026Q3", kind: "scheduled", survival_days: 45, threshold_days: 60,
        ewi_value: { deposit_outflow_bp: 300 }, haircut_table: { treasury: 0 },
        behavioral_assumptions: { runoff_bp: 1500 }, assumption_value: { runoff_bp: 1500 } }),
    env.db, "d", ops,
  );
  // NEGATIVE: an ad-hoc rerun that will not say what triggered it
  await postStressRun(R({ period: "2026Q3", kind: "adhoc", survival_days: 80 }), env.db, "d", ops);
  await postStressRun(
    R({ period: "2026Q3", kind: "adhoc", survival_days: 80, threshold_days: 60,
        trigger_reason: "EWI spike: 3% single-day deposit outflow",
        ewi_value: { deposit_outflow_bp: 300 } }),
    env.db, "d", ops,
  );

  // NEGATIVE: a tested facility with no script cannot be repeated
  await postFacility(R({ name: "FHLB Atlanta", kind: "fhlb", tested: true }), env.db, "d", ops);
  await postFacility(
    R({ name: "FHLB Atlanta", kind: "fhlb", tested: true,
        test_script: "draw $1m, confirm settlement, repay same day",
        contacts: { desk: "555-0199" }, collateral_schedule: { mortgages: "blanket lien" } }),
    env.db, "d", ops,
  );
  // NEGATIVE: headroom with no eligibility rules
  await postCollateralPosition(
    R({ unencumbered_cents: 30_000_000_00, pledged_cents: 10_000_000_00 }),
    "fac_fhlb", env.db, "d", ops,
  );
  await postCollateralPosition(
    R({ as_of_date: "2026-07-18", unencumbered_cents: 30_000_000_00,
        pledged_cents: 28_000_000_00, floor_cents: 5_000_000_00,
        eligibility_rules: { mortgages: "1-4 family, current" },
        pledge_schedule: { mortgages: 28_000_000_00 },
        move_detail: { out: "sold 2m of pledged paper" }, recompute: true }),
    "fac_fhlb", env.db, "d", ops,
  );

  for (const cadence of ["daily", "weekly", "board"]) {
    await postLiquidityPack(
      R({ cadence, period: "2026-07", concentration_top10: [{ name: "P1", bp: 400 }],
          ceo_summary: "LAR fell through the warning band on the 18th",
          weekly_deltas: { lar_bp: -700 }, limit_registry: ["LAR", "mismatch"] }),
      env.db, "d", ops,
    );
  }
}

/** Resolution: EWI sweep, freezes (targeted and institution-wide), portal, records. */
async function runResolutionLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.ewi_indicator"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  // entity first (fk_account_entity), seeded partner, no provenance column
  await env.db.schema("core").from("entity").upsert(
    { id: "ent_r1", type: "person", name: "Ryan Mercer", status: "active", partner_id: "ptnr_drill" },
    { onConflict: "id" },
  );
  await env.db.schema("core").from("account").upsert({
    id: "acct_rs1", entity_id: "ent_r1", status: "open", account_type: "checking",
    balance: 0, blnk_balance_id: "bal_rs1", partner_id: "ptnr_drill",
  }, { onConflict: "id" });

  // RS-02
  for (const [iid, thr] of [
    ["deposit_outflow_bp", { breach_at: 300 }], ["lar_bp", { breach_at: 700 }],
    ["nonperforming_bp", { breach_at: 200 }], ["unconfigured", null],
  ] as Any[]) {
    await postEwiIndicator(
      R({ indicator_id: iid, name: iid, thresholds: thr, schedule: "daily" }),
      env.db, "d", ops,
    );
  }
  await postEwiSweep(
    R({ period: "d1", observations: [
      { indicator_id: "deposit_outflow_bp", value: 100 },
      { indicator_id: "unconfigured", value: 99999 },
    ] }),
    env.db, "d", ops,
  );
  await postEwiSweep(
    R({ period: "d2", observations: [
      { indicator_id: "deposit_outflow_bp", value: 400 },
      { indicator_id: "lar_bp", value: 800 },
      { indicator_id: "nonperforming_bp", value: 300 },
    ] }),
    env.db, "d", ops,
  );

  // RS-04 — NEGATIVE: legal process with no reference
  await postAccountFreeze(R({ account_ref: "acct_rs1", authority: "garnishment" }), env.db, "d", ops);
  await postAccountFreeze(
    R({ account_ref: "acct_rs1", authority: "garnishment",
        legal_process_reference: "NC-CV-2026-118", order_reference: "ORD-1" }),
    env.db, "d", ops,
  );
  await postAccountFreeze(
    R({ account_ref: "acct_rs1", authority: "fraud_hold", order_reference: "FRD-9" }),
    env.db, "d", ops,
  );
  // credits still post under a garnishment: payroll must not bounce
  await postFrozenAccountCredit(
    R({ amount_cents: 250_000 }), "acct_rs1", env.db, "d", ops, "core", env.cfg,
  );
  // NEGATIVE: release with no reference
  await postFreezeRelease(R({}), "frz_acct_rs1_fraud_hold_FRD-9", env.db, "d", ops);
  await postFreezeRelease(
    R({ release_reference: "FRD-9-cleared" }), "frz_acct_rs1_fraud_hold_FRD-9", env.db, "d", ops,
  );

  // RS-05 — NEGATIVE: activation with no evidence
  await postInstitutionFreeze(
    R({ order_reference: "NCUA-ORD-1", ordered_by: "ncua_regional" }), env.db, "d", ops,
  );
  await postInstitutionFreeze(
    R({ order_reference: "NCUA-ORD-1", ordered_by: "ncua_regional",
        activation_evidence: { rails_disabled: ["ach", "wire", "card"], at: "12:00Z" },
        notice_template_id: "ntpl_freeze_v1", channels: ["website", "branch", "email"],
        regulator_reference: "NCUA-CONF-77" }),
    env.db, "d", ops,
  );
  // ...and lifted. The live control tier runs this lifecycle against the real
  // core every week; with the payment gate enforcing RS-05, a freeze the drill
  // never released halted every rail on the demo instance until it was.
  await postInstitutionFreezeRelease(
    R({ release_reference: "NCUA-REL-1", released_by: "ncua_regional" }), "instfrz_NCUA-ORD-1",
    env.db, "d", { ...ops, tokenId: "tok_rs5_cco", roles: ["cco"] },
  );

  // RS-06 — NEGATIVE: read-only with no dated snapshot
  await postMemberPortalState(R({ core_unavailable: true }), env.db, "d", ops);
  await postMemberPortalState(
    R({ core_unavailable: true, claims_template_id: "claims_v1",
        snapshot_as_of: "2026-07-18T23:59:59.000Z" }),
    env.db, "d", ops,
  );
  await postMemberPortalAccess(R({ member_ref: "mbr_r1" }), env.db, "d", ops);

  // RS-08 — NEGATIVE: a package whose chain does not match
  await postRecordsPackage(
    R({ manifest_id: "man_bad", snapshot_id: "snap_1", snapshot_as_of: "2026-07-18T23:59:59.000Z",
        artifact_id: "art_1", checksum_chain: { root: "deadbeef" },
        expected_checksum: "cafebabe" }),
    env.db, "d", ops,
  );
  await postRecordsPackage(
    R({ manifest_id: "man_good", snapshot_id: "snap_2", snapshot_as_of: "2026-07-18T23:59:59.000Z",
        snapshot_schedule: "nightly", artifact_id: "art_2",
        checksum_chain: { root: "cafebabe", links: 412 }, expected_checksum: "cafebabe" }),
    env.db, "d", ops,
  );
}

/** Basel: risk-weight schedule, RWA run, buffers, CFP profile. */
async function runBaselLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.rwa_schedule"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  // change_authority is supplied even though the FIRST schedule of a fresh
  // institution would not need it: on the live tier prior runs' schedules
  // accumulate, so this call is version 2+ there and the writer (correctly)
  // refuses a statutory-schedule change with no stated authority — which is
  // exactly how BA-04 read as a fake-vs-real defect.
  await postRwaSchedule(
    R({ risk_weight_map: { cash: 0, sovereign: 0, gse: 20, municipal: 50,
                           residential_mortgage: 50, consumer: 100, commercial: 100,
                           past_due: 150, equity: 300 },
        ccf_map: { undrawn_commitment: 50 }, approved_by: "cfo_1",
        change_authority: "12 CFR 702.104(b) — schedule re-adoption",
        regulatory_preapproval_id: "NCUA-PRE-4" }),
    env.db, "d", ops,
  );
  // NEGATIVE: changing a statutory schedule with no stated authority
  await postRwaSchedule(
    R({ risk_weight_map: { sovereign: 0, commercial: 50 }, approved_by: "cfo_1" }),
    env.db, "d", ops,
  );
  // the RWA run and the buffers live on capital.ts; this schedule feeds them
  await runCapitalLifecycle(env);

  // NEGATIVE: a CFP above normal with no liquidation hierarchy
  await postCfpProfile(
    R({ as_of_date: "2026-06-30", cfp_level: "heightened",
        gl_total_shares_cents: 350_000_000_00, hqla_cents: 40_000_000_00 }),
    env.db, "d", ops,
  );
  await postCfpProfile(
    R({ as_of_date: "2026-06-30", cfp_level: "heightened",
        gl_total_shares_cents: 350_000_000_00, hqla_cents: 40_000_000_00,
        net_outflows_30d_cents: 25_000_000_00, asf_total_cents: 300_000_000_00,
        rsf_total_cents: 280_000_000_00, clf_capacity_cents: 20_000_000_00,
        concentration: { top10_bp: 1800 },
        diversification_plan: "reduce top-10 share concentration below 15% by Q1",
        stress: { scenario: "severe", survival_days: 45 },
        liquidation_hierarchy: ["treasuries", "agency", "loan participations"],
        execution_plan_documented: true, investment_test_completed: true }),
    env.db, "d", ops,
  );
}

/** BCP: comms tree, incident comms failover, PIR and corrective actions. */
async function runBcpLifecycle(env: FireEnv): Promise<void> {
  // GUARD ON WHAT ONLY THIS LIFECYCLE WRITES. Twice now this guard has keyed on
  // a table the incident lifecycle later started writing (the comms tree, then
  // the PIR), and each time this whole lifecycle silently stopped running and
  // two controls went red. `corrective_action` is written here and nowhere else.
  if ((env.rows["core.corrective_action"] ?? []).length > 0) return;
  const ops = env.actors.ops;
  await runIncidentLifecycle(env);
  const inc = (env.rows["core.incident"] ?? [])[0];
  const incId = String(inc?.id ?? "");

  // NEGATIVE: a backup channel identical to the primary is not a backup
  await postCommsTree(
    R({ contact_tree: { ic: ["ceo"] }, primary: "email", backup: "email" }),
    env.db, "d", ops,
  );
  await postCommsTree(
    R({ contact_tree: { ic: ["ceo", "cfo"], tier2: ["ops"] },
        stakeholder_matrix: { members: "website", regulator: "phone" },
        primary: "email", backup: "sms" }),
    env.db, "d", ops,
  );
  if (incId) {
    // NEGATIVE: a media response with no CEO approval
    await postIncidentComms(
      R({ platform_failed: true, media_inquiry: true,
          holding_statement: "we are investigating" }),
      incId, env.db, "d", ops,
    );
    await postIncidentComms(
      R({ platform_failed: true, media_inquiry: true,
          holding_statement: "we are investigating",
          ceo_approval: "ceo_1 approved 12:40Z" }),
      incId, env.db, "d", ops,
    );
    // NEGATIVE: a PIR drafted with no root cause
    await postPir(R({ impact_summary: "1400 members" }), incId, env.db, "d", ops);
    await postPir(
      R({ root_cause: "credential stuffing against an un-rate-limited endpoint",
          timeline: [{ at: "11:00Z", what: "first failed logins" }],
          impact_summary: "1,400 members' account numbers exposed" }),
      incId, env.db, "d", ops,
    );
    await postCorrectiveAction(
      R({ key: "ratelimit", description: "rate-limit the login endpoint", owner: "eng_1",
          approved_by: "ciso_1", retest_result: "verified: 429 after 5 attempts" }),
      `pir_${incId}`, env.db, "d", ops,
    );
    // an action approved but NOT retested — completed is not evidence
    await postCorrectiveAction(
      R({ key: "mfa", description: "require MFA on password reset", owner: "eng_2",
          approved_by: "ciso_1", completed: true }),
      `pir_${incId}`, env.db, "d", ops,
    );
  }
}

/** The tail: SoD, reconciliation, assets, red flags, EPS, affiliates, capital actions. */
async function runTailLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.sod_rule"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  // IC-02
  await postSodRule(
    R({ role_a: "payment_initiator", role_b: "payment_approver",
        conflict: "initiate and approve the same payment",
        rationale: "one person could move money without a second pair of eyes" }),
    env.db, "d", ops,
  );
  // NEGATIVE: a rule against a role and itself would block every grant
  await postSodRule(
    R({ role_a: "teller", role_b: "teller", rationale: "x" }), env.db, "d", ops,
  );
  await postRoleGrant(
    R({ subject_ref: "usr_1", role_id: "payment_initiator",
        entitlements: ["ach.create", "wire.prepare"] }),
    env.db, "d", ops,
  );
  // NEGATIVE: the conflicting grant is BLOCKED, not warned about
  await postRoleGrant(
    R({ subject_ref: "usr_1", role_id: "payment_approver", entitlements: ["wire.approve"] }),
    env.db, "d", ops,
  );
  // run-unique subject: on the live tier last run's approver grant survives,
  // which BLOCKS this run's initiator grant and then the approver grant no
  // longer conflicts — the compensating branch never runs (IC-02's defect)
  const usrSod = `usr_sod_${env.n()}`;
  await postRoleGrant(
    R({ subject_ref: usrSod, role_id: "payment_initiator", entitlements: ["ach.create"] }),
    env.db, "d", ops,
  );
  await postRoleGrant(
    R({ subject_ref: usrSod, role_id: "payment_approver", entitlements: ["wire.approve"],
        compensating_control: "all payments over $10k reviewed by internal audit weekly",
        compensating_approved_by: "cro_1",
        risk_rationale: "two-person team; conflict unavoidable" }),
    env.db, "d", ops,
  );

  // IC-04
  await postReconItem(
    R({ recon_ref: "gl_cash_20260718", cadence: "daily", variance_cents: 12_50,
        owner: "acct_1", age_days: 1, gl_balances: { cash: 1_000_000_00 },
        gl_trial_balance: { debits: 1, credits: 1 } }),
    env.db, "d", ops,
  );
  // NEGATIVE: old enough to escalate with nothing researched
  await postReconItem(
    R({ recon_ref: "gl_susp_old", cadence: "monthly", variance_cents: 400_00,
        owner: "acct_2", age_days: 45, gl_balances: { suspense: 400_00 } }),
    env.db, "d", ops,
  );
  await postReconItem(
    R({ recon_ref: "gl_susp_old", cadence: "monthly", variance_cents: 400_00,
        owner: "acct_2", age_days: 45, gl_balances: { suspense: 400_00 },
        research_notes: "traced to an unposted ACH return from March; chasing the ODFI",
        resolution: "posted the return and closed the suspense entry" }),
    env.db, "d", ops,
  );

  // IS-03 — NEGATIVE: an asset with no owner
  await postItAsset(R({ asset_id: "srv_1", classification: "restricted" }), env.db, "d", ops);
  await postItAsset(
    R({ asset_id: "srv_1", owner: "infra_lead", classification: "restricted",
        media_type: "virtual", attributes: { env: "prod", data: "member_pii" },
        cmdb_snapshot: { hostname: "core-db-1" }, owner_roster: ["infra_lead"],
        attest: true, attested_by: "infra_lead" }),
    env.db, "d", ops,
  );

  // IS-10 — NEGATIVE: disposing a case whose required step-up never completed
  await postRedflagCase(
    R({ account_id: "acct_rf1", type: "address_change_then_card_request",
        address_reissue_match: true, stepup_required: true,
        disposition: "closed, no fraud" }),
    env.db, "d", ops,
  );
  await postRedflagCase(
    R({ account_id: "acct_rf1", type: "address_change_then_card_request",
        address_reissue_match: true, stepup_required: true, stepup_completed: true,
        disposition: "confirmed takeover attempt; card blocked",
        sar_filing_id: "SAR-2026-118" }),
    env.db, "d", ops,
  );
  await postRedflagRuleset(
    R({ ruleset: { address_then_card_days: 30 },
        pattern_updates: ["tighten the address-change window to 45 days"] }),
    env.db, "d", ops,
  );

  // CP-08 / CP-09 — NEGATIVE: executing ahead of the regulator
  await postCapitalAction(
    R({ position_id: "cap_20260331", action_type: "subordinated_debt",
        amount_cents: 5_000_000_00, expected_capital_impact_cents: 5_000_000_00,
        regulatory_preapproval_status: "pending",
        regulatory_preapproval_id: "NCUA-PRE-9",
        board_resolution_id: "BR-2026-4", execute: true }),
    env.db, "d", ops,
  );
  await postCapitalAction(
    R({ position_id: "cap_20260331", action_type: "subordinated_debt",
        amount_cents: 5_000_000_00, expected_capital_impact_cents: 5_000_000_00,
        projected_shortfall_cents: 2_000_000_00, projection_below_target: true,
        projection_below_well_capitalized: false,
        subordinated_debt_cents: 5_000_000_00,
        instrument_terms: { tenor_years: 10, rate_bp: 750 },
        eligible_retained_income_cents: 1_200_000_00,
        action_analysis_id: "ANA-2026-1",
        regulatory_preapproval_status: "granted",
        regulatory_preapproval_id: "NCUA-PRE-9",
        board_resolution_id: "BR-2026-4", execute: true }),
    env.db, "d", ops,
  );
  // NEGATIVE: a distribution while distributions are restricted
  await postCapitalAction(
    R({ position_id: "cap_20260331", action_type: "distribution",
        amount_cents: 500_000_00, expected_capital_impact_cents: -500_000_00,
        proposed_distribution_amount_cents: 500_000_00,
        distribution_restriction: true,
        board_resolution_id: "BR-2026-5", execute: true }),
    env.db, "d", ops,
  );

  // DF-06 / DF-09
  // Run-unique affiliate: the DF-06 limit is on AGGREGATE funded exposure
  // (fixed 2026-10-06), so on the live tier a fixed affiliate accumulates every
  // previous run's funded credit and the in-limit credit below would 409.
  const cuso = `PynthiaCUSO_${env.n()}`;
  const affId = `aff_${cuso}`;
  await postAffiliate(R({ list_entry: cuso, relationship: "cuso" }), env.db, "d", ops);
  // NEGATIVE: over the limit
  await postAffiliateTransaction(
    R({ type: "credit", amount_cents: 20_000_000_00, capital_surplus_cents: 100_000_000_00,
        lqa_screened: true, fund: true }),
    affId, env.db, "d", ops,
  );
  // NEGATIVE: unscreened is not screened-and-clean
  await postAffiliateTransaction(
    R({ type: "credit", amount_cents: 5_000_000_00, capital_surplus_cents: 100_000_000_00,
        fund: true }),
    affId, env.db, "d", ops,
  );
  await postAffiliateTransaction(
    R({ type: "credit", amount_cents: 5_000_000_00, capital_surplus_cents: 100_000_000_00,
        collateral_type: "us_treasury", collateral_value_cents: 6_500_000_00,
        required_coverage_ratio_bp: 13000, market_terms_basis: "third-party rate sheet",
        asset_quality_classification: "pass",
        independent_evaluation: "reviewed by outside counsel 2026-06",
        lqa_screened: true, fund: true }),
    affId, env.db, "d", ops,
  );
  if ((env.rows["core.insider"] ?? []).length === 0) {
    // subject_ref / role / effective_from are NOT NULL on the live schema —
    // the bare {id, provenance} row only ever existed on the fake
    await env.db.schema("core").from("insider").upsert({
      id: "ins_df9", subject_ref: "dir_9", role: "director",
      effective_from: "2026-01-01T00:00:00.000Z", provenance: "production",
    }, { onConflict: "id" });
  }
  const ins = (env.rows["core.insider"] ?? [])[0];
  if (ins) {
    await postInsiderPublicRequest(
      R({ capital_surplus_cents: 100_000_000_00,
          correspondent_credit_data: { banks: ["Corr Bank NA"] } }),
      String(ins.id), env.db, "d", ops,
    );
  }

  // EPS-06: the client limit change is a REQUEST that a second person decides
  await putClientLimit(
    R({ ach_dual_control_over_cents: 25_000_00,
        ach_client_exposure_limit_cents: 500_000_00,
        wire_daily_limit_cents: 250_000_00 }),
    // ptnr_drill is the seeded partner — client_limit has a REAL fk to
    // core.partner, and "p1" only ever existed on the fake
    "ptnr_drill", env.db, "d", ops,
  );
  // The fixture wire must match the REAL wire_transfer shape: uuid id,
  // `amount` (not amount_cents), jsonb beneficiary, a status the CHECK
  // accepts, no provenance column, and the seeded partner (EPS-06's original
  // fake-vs-real defect — the fake accepted all five mismatches).
  const wtEps1 = crypto.randomUUID();
  await env.db.schema("core").from("wire_transfer").upsert({
    id: wtEps1, partner_id: "ptnr_drill", amount: 300_000_00,
    beneficiary: { name: "Beneficiary Co" }, status: "pending_approval",
  }, { onConflict: "id" });
  await openApproval(env.db, {
    resourceType: "wire_transfer", resourceId: wtEps1, createdBy: "tok_ops_1",
    decision: wireDualControl(), scope: "core", ctx: ops,
  });
  await postPaymentApproval(
    R({ outcome: "approve" }), "wire_transfer", wtEps1, env.db, "d",
    { ...ops, tokenId: "tok_ops_2" } as Any,
  );
  // NEGATIVE: no IP allowlist configured -> unknown, and unknown is not permission
  await postWireRelease(
    R({ wire_ref: wtEps1, originator_id: "orig_1", pin_verified: true,
        ip: "203.0.113.9", second_approval: "tok_ops_2" }),
    env.db, "d", ops,
  );
  await postWireRelease(
    R({ wire_ref: "wt_eps2", originator_id: "orig_1", pin_verified: true,
        ip: "203.0.113.9", ip_allowlist: ["203.0.113.9"],
        second_approval: "tok_ops_2", amount_cents: 300_000_00,
        beneficiary: "Beneficiary Co" }),
    env.db, "d", ops,
  );
  // NEGATIVE: a verdict with no individual check results
  await postAchControlResults(
    R({ transfer_ref: "ach_1", amount_cents: 40_000_00 }), env.db, "d", ops,
  );
  await postAchControlResults(
    R({ transfer_ref: "ach_1", amount_cents: 40_000_00,
        exposure_limit_cents: 500_000_00, template_only: true,
        checks: { within_exposure_limit: true, template_matched: true,
                  dual_control: true, ofac_screened: true, prenote_valid: true } }),
    env.db, "d", ops,
  );
  // NEGATIVE: a change approved by its own requester
  await postEpsLimitChange(
    R({ partner_id: "p1", justification: "seasonal volume",
        approver_id: ops.tokenId, wire_daily_limit_cents: 400_000_00 }),
    env.db, "d", ops,
  );
  await postEpsLimitChange(
    R({ partner_id: "p1", justification: "seasonal volume; reviewed against 90-day history",
        approver_id: "cro_1", wire_daily_limit_cents: 400_000_00,
        ach_exposure_limit_cents: 600_000_00 }),
    env.db, "d", ops,
  );
  await postPospayItem(
    R({ issue_file: "if_20260718", item_ref: "chk_1041",
        item: { check_no: 1041, amount_cents: 12_500_00 }, decision: "return" }),
    env.db, "d", ops,
  );

  // EPS — NEGATIVE: activation before ERM approved it
  await postEpsProposal(
    R({ service_id: "rtp", sponsor: "vp_payments", study_doc: "rtp-study-v2",
        design_docs: ["arch-v1"], inherent_score: 7,
        risk_assessment_delta: { new_rails: 1 }, activate: true }),
    env.db, "d", ops,
  );
  await postEpsProposal(
    R({ service_id: "rtp", sponsor: "vp_payments", study_doc: "rtp-study-v2",
        design_docs: ["arch-v1"], inherent_score: 7,
        risk_assessment_delta: { new_rails: 1 },
        erm_decision: "approved", erm_reviewed_by: "cro_1", activate: true }),
    env.db, "d", ops,
  );
  // NEGATIVE: a found deficiency with no rating cannot be prioritised
  await postEpsControlReview(
    R({ service_id: "rtp", checklist: { dual_control: true }, deficiency_found: true,
        description: "no dual control on limit changes" }),
    env.db, "d", ops,
  );
  await postEpsControlReview(
    R({ service_id: "rtp", checklist: { dual_control: true },
        prior_findings: ["2025: limit change logging"],
        deficiency_found: true, description: "no dual control on limit changes",
        rating: "high" }),
    env.db, "d", ops,
  );
  // NEGATIVE: no rollback plan
  await postEpsDeployment(R({ service_id: "rtp", test_plan: "interop-v1" }), env.db, "d", ops);
  // NEGATIVE: an emergency exception nobody approved
  await postEpsDeployment(
    R({ service_id: "rtp", test_plan: "interop-v1", rollback_plan: "revert to v3.2",
        emergency: true }),
    env.db, "d", ops,
  );
  await postEpsDeployment(
    R({ service_id: "rtp", test_plan: "interop-v1", rollback_plan: "revert to v3.2",
        interop_scope: { partners: ["TCH"] }, vendor_participated: true,
        results: { passed: 41, failed: 1 }, defects: ["timeout on resend"],
        risk_acceptance: "accepted by vp_payments; resend path is manual until v3.4",
        emergency: true, exception_approval: "cto_1 approved 2026-07-18",
        retro_completed: true }),
    env.db, "d", ops,
  );
}

async function runCapitalLifecycle(env: FireEnv): Promise<void> {
  // A WELL-CAPITALIZED position with a configured internal trigger. The trigger
  // sits above the statutory floor, so this position is compliant with NCUA and
  // still breaches the institution's own early warning — which is the entire
  // point of CP-03 having two layers.
  await postCapitalPosition(
    R({
      as_of_date: "2026-03-31",
      net_worth_cents: 7_500_000_00,
      total_assets_cents: 100_000_000_00,
      internal_trigger_bp: 800,
      tier1_cents: 6_000_000_00,
      tier2_cents: 1_500_000_00,
      classification_approved_by: "cfo_01",
    }),
    env.db, "d", env.actors.ops,
  );
  await postRwaRun(
    R({
      gl_total_assets_cents: 400_000_000_00, gl_total_loans_cents: 250_000_000_00,
      gross_income_cents: 20_000_000_00, trading_book_cents: 12_000_000_00,
      ccf_map: { undrawn_commitment: 50 },
      exposures: [
        { class: "cash", amount_cents: 5_000_000_00 },
        { class: "residential_mortgage", amount_cents: 40_000_000_00 },
        { class: "consumer", amount_cents: 20_000_000_00 },
        // NEGATIVE: an exposure class with no published weight. It must be
        // surfaced as unmapped rather than weighted at zero, because zero is
        // the direction that flatters the institution.
        { class: "crypto_exposure", amount_cents: 1_000_000_00 },
      ],
    }),
    "cap_20260331", env.db, "d", env.actors.ops,
  );
  await postCapitalAction(
    R({ position_id: "cap_20260331", action_type: "subordinated_debt",
        amount_cents: 5_000_000_00, expected_capital_impact_cents: 5_000_000_00,
        projected_shortfall_cents: 2_000_000_00, projection_below_target: true,
        projection_below_well_capitalized: false,
        subordinated_debt_cents: 5_000_000_00,
        instrument_terms: { tenor_years: 10, rate_bp: 750 },
        eligible_retained_income_cents: 1_200_000_00, action_analysis_id: "ANA-2026-1",
        regulatory_preapproval_status: "granted", regulatory_preapproval_id: "NCUA-PRE-9",
        proposed_distribution_amount_cents: 0, distribution_restriction: true,
        board_resolution_id: "BR-2026-4", execute: true }),
    env.db, "d", env.actors.ops,
  );
  // NEGATIVE: no CCyB configured -> no payout cap, so no distribution verdict
  await postCapitalBuffer(
    R({ as_of_date: "2026-06-29", cet1_ratio_bp: 900, requirement_bp: 1050 }),
    env.db, "d", env.actors.ops,
  );
  await postCapitalBuffer(
    R({ as_of_date: "2026-06-30", cet1_ratio_bp: 900, requirement_bp: 1050,
        ccyb_level_bp: 100, proposed_ccyb_level_bp: 125,
        dividend_schedule: { q3: 500_000_00 },
        proposed_distribution_amount_cents: 500_000_00, loan_growth_yoy_bp: 1800 }),
    env.db, "d", env.actors.ops,
  );

  // An UNDERCAPITALIZED position: 5.00% net worth ratio. This must classify as
  // undercapitalized, restrict distributions, and start the 45-day NWRP clock
  // in the same write.
  await postCapitalPosition(
    R({
      as_of_date: "2026-06-30",
      net_worth_cents: 5_000_000_00,
      total_assets_cents: 100_000_000_00,
      internal_trigger_bp: 800,
    }),
    env.db, "d", env.actors.ops,
  );
  await postNwrp(R({ filed_by: "cfo_01" }), "cap_20260630", env.db, "d", env.actors.ops);

  // NEGATIVE: a position with NO Board-approved internal trigger, left
  // unassessed, so the sweep has something to report as not-covered rather
  // than reporting a clean bill of health over the whole book.
  await postCapitalPosition(
    R({
      as_of_date: "2026-09-30",
      net_worth_cents: 4_200_000_00,
      total_assets_cents: 100_000_000_00,
    }),
    env.db, "d", env.actors.ops,
  );
  // and leave THIS one's restoration plan unfiled and overdue, so the sweep
  // has a real overdue case rather than an empty one.
  const rec = (env.rows["core.capital_position"] ?? []).find(
    (x: Any) => x.id === "cap_20260930",
  );
  if (rec) rec.nwrp_due_at = "2020-01-01T00:00:00.000Z";

  const cco = { ...env.actors.ops, tokenId: "tok_cco", roles: ["cco"] };
  const cfo = { ...env.actors.ops, tokenId: "tok_cfo", roles: ["cfo"] };

  // CP-01: a Board-approved internal target, above the statutory floor and
  // approved by someone other than its proposer. CP-03 four eyes binds to the
  // CREDENTIAL, so it takes two calls by two tokens: the proposal on file,
  // then the approval by a different one.
  await postCapitalTarget(
    R({ effective_date: "2026-01-01", target_bp: 900, proposed_by: "cfo_01" }),
    env.db, "d", cco,
  );
  await postCapitalTarget(
    R({ effective_date: "2026-01-01", target_bp: 900, proposed_by: "cfo_01", approved_by: "board_chair" }),
    env.db, "d", { ...cco, tokenId: "tok_board" },
  );
  // NEGATIVE: a target BELOW the 700bp floor must be refused, not stored as a
  // target that can never be breached.
  await postCapitalTarget(
    R({ effective_date: "2026-01-02", target_bp: 650, proposed_by: "cfo_01", approved_by: "board_chair" }),
    env.db, "d", cco,
  );
  // NEGATIVE: self-approval must be refused.
  await postCapitalTarget(
    R({ effective_date: "2026-01-03", target_bp: 900, proposed_by: "cfo_01", approved_by: "cfo_01" }),
    env.db, "d", cco,
  );

  for (const kind of ["capital_plan", "stress_report", "icaap_report"]) {
    await postCapitalDocument(
      R({ kind, cycle: "2026Q2", prepared_by: "cfo_01", presented_to: "alm_committee", reviewed_by: "board_chair" }),
      env.db, "d", cfo,
    );
  }
  // NEGATIVE: reviewed without ever being presented.
  await postCapitalDocument(
    R({ kind: "capital_plan", cycle: "2026Q3", prepared_by: "cfo_01", reviewed_by: "board_chair" }),
    env.db, "d", cfo,
  );

  await postCapitalSweep(R({}), env.db, "d", env.actors.ops);
}

async function runIncidentLifecycle(env: FireEnv): Promise<void> {
  const compliance = { ...env.actors.ops, tokenId: "tok_compliance", roles: ["bsa_compliance"] };
  const res = await postIncident(
    R({ id: "inc_drill_main", title: "drill incident", severity: "sev1", source: "siem" }),
    env.db, "d", env.actors.ops,
  );
  const id = String((await res.clone().json().catch(() => ({}))).id ?? "");
  if (!id) return;
  await postFirstHour(R({ summary: "scope established" }), id, env.db, "d", env.actors.ops);
  // EC-13: the assessment PRECEDES the determination and is a different act
  await postIncidentAssessment(
    R({ data_scope: { members: 1400, fields: ["name", "account_number"] },
        member_impact: "1,400 members' account numbers exposed",
        facts: { vector: "credential stuffing", contained: true },
        scope_initial: "online banking session store", detection_source: "siem" }),
    id, env.db, "d", env.actors.ops,
  );
  // NEGATIVE: external comms before legal review is refused
  await postExternalComms(R({ holding_statement: "we are investigating" }), id, env.db, "d", env.actors.ops);
  await postExternalComms(
    R({ holding_statement: "we are investigating an incident affecting online banking",
        legal_reviewed_by: "counsel_1", comms_plan: { channels: ["website", "email"] } }),
    id, env.db, "d", env.actors.ops,
  );
  await postDetermineReportability(
    R({ is_reportable: true, rationale: "member data likely misused" }),
    id, env.db, "d", compliance,
  );
  await postNotifyNcua(R({ reference: "NCUA-DRILL-1" }), id, env.db, "d", env.actors.ops);
  await postMemberImpact(R({ confirmed: true, template: "appendix-b" }), id, env.db, "d", env.actors.ops);
  await postContainIncident(R({}), id, env.db, "d", env.actors.ops);
  // IS-19: the postmortem is only claimable once the PIR that carries the root
  // cause exists, so the PIR is drafted before closure rather than after.
  await postPir(
    R({ root_cause: "credential stuffing against an un-rate-limited endpoint",
        timeline: [{ at: "11:00Z", what: "first failed logins" }],
        impact_summary: "1,400 members' account numbers exposed" }),
    id, env.db, "d", env.actors.ops,
  );
  await postCloseIncident(R({}), id, env.db, "d", env.actors.ops);
  // a SECOND incident left undetermined, so the sweep has both negatives
  const r2 = await postIncident(
    R({ id: "inc_drill_undet", title: "undetermined", severity: "sev2" }), env.db, "d", env.actors.ops,
  );
  const id2 = String((await r2.clone().json().catch(() => ({}))).id ?? "");
  if (id2) {
    // the NCUA clock only exists once reportability is DETERMINED
    // (ck_incident_ncua_due_after_determination), so the overdue fixture must
    // backdate both — a due date on an undetermined incident is a row the
    // schema correctly refuses
    await env.db.schema("core").from("incident").update({
      reportability_determined_at: "2020-01-01T00:00:00.000Z",
      ncua_notice_due_at: "2020-01-04T00:00:00.000Z",
    }).eq("id", id2);
  }
  await postCommsTree(
    R({ contact_tree: { ic: ["ceo", "cfo"], tier2: ["ops"] },
        stakeholder_matrix: { members: "website", regulator: "phone" },
        primary: "email", backup: "sms" }),
    env.db, "d", env.actors.ops,
  );
  await postIncidentComms(
    R({ holding_statement: "we are investigating" }), id, env.db, "d", env.actors.ops,
  );
  await postIncidentSweep(R({}), env.db, "d", env.actors.ops);
}
import {
  postAuthEvent, postCardControl, postFraudTrendReview, postPospayDecision,
  postPospayException,
} from "../api/eps_controls.ts";
import { postCardReissue, postIssueCard } from "../api/cards.ts";
import {
  postAffiliate, postAffiliateTransaction, postCapitalAction, postEpsControlReview,
  postEpsDeployment, postEpsProposal, postInsiderPublicRequest, postItAsset,
  postAchControlResults, postEpsLimitChange, postPospayItem, postReconItem,
  postRedflagCase, postRedflagRuleset, postRoleGrant, postSodRule, postWireRelease,
} from "../api/tail.ts";
import {
  postCapitalBuffer, postCfpProfile, postCommsTree, postCorrectiveAction,
  postIncidentComms, postPir, postRwaSchedule,
} from "../api/basel.ts";
import {
  postAccountFreeze, postEwiIndicator, postEwiSweep, postFreezeRelease,
  postFrozenAccountCredit, postInstitutionFreeze, postInstitutionFreezeRelease, postMemberPortalAccess,
  postMemberPortalState, postRecordsPackage,
} from "../api/resolution.ts";
import {
  postCollateralPosition, postFacility, postLarBandConfig, postLiquidityPack,
  postLiquidityPosition, postMaturityMismatch, postStressAssumptions, postStressRun,
} from "../api/liquidity.ts";
import {
  postCredentialIssue, postEcommerceRiskAssessment, postEcommerceTransaction, postEnrollment,
  postLoginFailure, postPasswordChange, postRepudiationReview,
} from "../api/ecommerce.ts";
import {
  postAddressChange, postApplicationOptions, postDisclosureDelivery, postDisclosureTemplate,
  postGmiCollection, postInterestAccrualRun, postInterestConfig, postLoCompPlan,
  postMemberPreferences, postMemberRecordExport, postMemberRestriction, postMembership,
  postApplicationIntake, postBalanceInquiry, postNoticeQueue, postServiceRequest, postStatement,
} from "../api/deposits_member.ts";
import {
  postChargeOff, postCollectionContact, postCollectionProtection, postCollectionsPolicy,
  postDelinquencyEvaluation, postFurnishingCycle, postLoanModification,
  postOverdraftReferral,
} from "../api/collections.ts";
import {
  postAnalyticsDataset, postBiometricPurge, postBiometricVerification,
  postDisposalCertificate, postEsignConsent, postFurnishingCorrection,
  postFurnishingDispute, postMinorDataEvent, postNoticeDelivery, postNotificationDecision,
  postPreferencePropagation, postPrivacyNotice, postPrivacyPreference,
  postStateRequest, postStateRequestFulfilment, postWebConsent, postWebTagReview,
} from "../api/privacy.ts";
import {
  postAccessDeprovision, postAccessGrant, postAccessReview, postAiTool,
  postAiToolDecision, postAiToolLaunch, postAiViolation, postAiViolationDispose,
  postAntivirusEvent, postAntivirusRemediate, postBackupCycle, postBackupRemediate,
  postIntrusionResponse, postPentestEngagement, postPentestReport, postRestoreTest,
  postSecurityReview, postSiemAlert, postSiemDispose, postSiemSourceRestore,
  postDlpResolve, postDlpViolation,
  postSiemSourceSilent, postTlsAssessment, postTlsRenew, postVulnFinding,
  postVulnRemediate, postVulnTriage,
} from "../api/ops_security.ts";
import {
  postIncidentContainmentStart, postIncidentFailover, postIncidentLegalConsult,
  postIncidentMemberStatus, postIncidentVendorTracks,
} from "../api/incidents.ts";
import {
  postAlcoRatioReview, postEodTieout, postLiquidityConcentration, postModelReview,
  postNcuaAck, postNcuaNotification, postRegulatorContactsVerify, postRegulatorRequest,
  postRegulatorResponse, postWholesaleExposure,
} from "../api/liquidity.ts";
import { postPillar3Disclosure } from "../api/basel.ts";
import { postTrainingAssignment } from "../api/hr.ts";
import {
  post314aRequest, post314aResponse, postCipVerification, postCmirFiling,
  postCtrExemptionReview, postEddCompletion, postEddProfile, postEscalation,
  postEscalationAck, postFbarAccount, postFbarFiling, postMonetaryInstrument,
  postOfacAnnualReport, postOfacRelease, postOfacScreen, postPepScreen,
  postRegulatoryChange, postSarLifecycle, postTravelRuleRecord,
} from "../api/bsa_program.ts";
import {
  postControlException, postControlExceptionSweep, postControlOverride,
  postOverrideAnalytics, postRiskAcceptance, postRiskAcceptanceDecision,
  postRiskAcceptanceSweep, postRiskBreachPresentation, postRiskObservation,
  putRisk, putRiskAppetite,
} from "../api/risk_exceptions.ts";
import {
  postComplaint, postComplaintAcknowledge, postComplaintBoardReport, postComplaintResolve,
  postComplaintResponse, postComplaintTrend, postDispute, postDisputeResolve,
  postProvisionalCredit,
} from "../api/complaints.ts";
import {
  postAlmSimulation, postCfpLevelChange, postCreditFile, postCreditFileReanalysis,
  postFairValue, postInstrumentListEntry, postIntermediary, postLiquidityClassification,
  postLiquidityReport, postPerformanceMeasurement, postPortfolioReport, postRepoAgreement,
  postSafekeepingReconciliation, postSecurityDowngrade, postTrade, postTradeConfirmation,
  postTradeException, postTradeReconciliation, putLimitSet, putUserRole,
} from "../api/investment.ts";
import {
  postAppraisalComplete, postAppraisalOrder, postAtrQm, postCreditApplicationRecord,
  postCreditConfig, postCreditDecisionRecord, postCreditReport, postFairLendingAnalysis,
  postFairLendingRemediationClose, postHmdaLar, postInsiderLoanReview, postLoanException,
  postLoanExceptionAnalytics, postLoanExceptionDecision, postLoanPricing,
  postLendingAdverseAction, postLoanBooking,
  postPrequalification, postPricingExceptionReview, postProductScreen, postRateSheet,
  putInsider,
} from "../api/lending_underwriting.ts";
import {
  postArchiveConfirmation, postCddProfile, postCddRefresh, postDestructionLogReconcile,
  postDestructionLogResolve, postIntegrityTestComplete, postIntegrityTestSchedule,
  postRecordClassify, postRecordDisposition, postRecordsPolicyReview,
  postRetentionScheduleEntry, postStorageBox, putRecordsContact,
} from "../api/records_admin.ts";
import {
  postCashBoardSummary, postCashDeviationDecision, postCashDeviationRequest,
  postCashEnterprisePosition, postCashEnterpriseRemediation, postCashException,
  postCashCustody, postCashCustodyAttest, postCashKeyboxOpen,
  postCashKriPublish, postCashLimitsSchedule, postCashLoad, postCashNightDropRetrieval,
  postCashOverShort, postCashOverShortResolve, postCashPolicyAdoption,
  postCashRecordsPackage, postCashReconciliation, postCashShipment,
  postCashShipmentVerify, postCashSurpriseCountComplete, postCashSurpriseCountSchedule,
  postCashSuspenseClear, postCashSuspenseSweep, putCashAsset,
} from "../api/cash_ops.ts";
import {
  postEmployee, postEmployeeCoaching, postEmployeeSeparate, postEmployeeTraining,
} from "../api/hr.ts";
import {
  postDeathReport, postEstateClaim, postEstatePayout, postExpulsion,
  postExpulsionClose, postExpulsionHearing, postSafeModeActivate,
  postSafeModeDeactivate, postSafeModeProcessorConfirm, safeModeGate,
} from "../api/member_protection.ts";
import {
  postConnectionScopeViolation, postPrivacyAccessRequest, postPrivacyConnection,
  postPrivacyDisclosure,
} from "../api/privacy.ts";
import {
  postCda, postCdaAgreement, postCdaAuditCycle, postCdaCallReportMapping, postCdaCapCure,
  postCdaCapTest, postCdaClose, postCdaCommunication, postCdaCommunicationApproval,
  postCdaCommunicationPublish, postCdaDistribution, postCdaDistributionWindow,
  postCdaFeePayment, postCdaFindingClose, postCdaFunding, postCdaGlossaryChange,
  postCdaInkindTransfer, postCdaPolicyAdoption, postCdaPolicySweep, postCdaPosttradeCheck,
  postCdaQuarterClose, postCdaReconciliation, postCdaTermination, postCdaTrade,
  postCdaValuationReview, postCdaVendor, postCdaVendorReview, putCdaOverlay,
} from "../api/cda.ts";
import {
  postCapitalDocument, postCapitalPosition, postCapitalSweep, postCapitalTarget,
  postNwrp, postRwaRun,
} from "../api/capital.ts";
import {
  postApproveAuditPlan, postAuditEngagement, postAuditSweep, postCloseFinding,
  postCompleteFieldwork, postFindingResponse, postIssueAuditReport, postStartAuditEngagement,
} from "../api/audit.ts";

/**
 * The whole audit engagement lifecycle, driven end to end.
 *
 * Every AU-* trigger is reached by running the REAL sequence: submit a plan,
 * have a different actor approve it, attest independence, start, complete
 * fieldwork with a rating, issue a report that opens findings, respond, retest,
 * close, and sweep for aged findings. Nothing is handed a code to emit.
 */
async function runAuditLifecycle(env: FireEnv, rating = "poor"): Promise<void> {
  const n = env.n();
  const scope = `Scope ${n}`;
  const open = await postAuditEngagement(
    R({ plan_cycle_year: 2026, scope, auditor_ref: `auditor_${n}` }),
    env.db, "d", env.actors.ops,
  );
  const id = String((await open.clone().json().catch(() => ({}))).id ?? "");
  if (!id) return;
  // a DIFFERENT actor approves — four-eyes, for real
  await postApproveAuditPlan(R({}), id, env.db, "d", env.actors.approver);
  await postStartAuditEngagement(R({ independence_attested: true }), id, env.db, "d", env.actors.reviewer);
  await postCompleteFieldwork(R({ rating }), id, env.db, "d", env.actors.ops);
  await postIssueAuditReport(
    R({ findings: [{ severity: "critical", summary: "control gap" }] }),
    id, env.db, "d", env.actors.officer,
  );
  const fid = `afind_${id}_0`;
  await postFindingResponse(R({ response: "will remediate" }), fid, env.db, "d", env.actors.ops);
  // age it so the sweep has something to escalate — through the client
  await env.db.schema("core").from("audit_finding")
    .update({ remediation_due_at: "2020-01-01T00:00:00.000Z" }).eq("id", fid);
  await postAuditSweep(R({}), env.db, "d", env.actors.ops);
  // a failed retest re-communicates; then risk acceptance closes it
  await postCloseFinding(R({ retest_result: "failed" }), fid, env.db, "d", env.actors.officer);
  await postCloseFinding(
    R({ risk_acceptance: "accepted", rationale: "compensating control" }),
    fid, env.db, "d", env.actors.officer,
  );
}

export interface FireEnv {
  db: Any;
  rows: Record<string, Any[]>;
  cfg: Any;
  ctx: Any;
  actors: Record<string, Any>;
  /** monotonic counter so ids never collide across 316 tests */
  n: () => number;
}

const R = (b?: unknown, h: Record<string, string> = {}) =>
  new Request("https://drill/x", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": `k${Math.random()}`, ...h },
    body: b === undefined ? undefined : JSON.stringify(b),
  });

/**
 * THE GENERIC FIRER.
 *
 * Any trigger that is a cadence — `*.due`, `*.due_at`, `*.timer`,
 * `*cycle.opened` — can be produced by registering an obligation carrying that
 * code and sweeping the calendar. That is not a trick: it is exactly what the
 * governance calendar is for, and it makes all 83 time-based triggers firable
 * through one mechanism.
 */
const TIMER_RE = /(\.due(_at)?$|\.timer$|_timer$|cycle\.opened$|cycle_timer$|\.due$)/;

export async function fireViaObligation(code: string, uid: string, env: FireEnv): Promise<void> {
  await postObligation(
    R({
      control_uid: uid,
      trigger_code: code,
      title: `drill: ${code}`,
      cadence: "annual",
      anchor_date: "2026-01-01",
    }),
    env.db, "d", env.actors.ops,
  );
  await postCalendarSweep(R({}), env.db, "d", env.actors.ops);
}

/**
 * Explicit firers for triggers with a real writer. Each returns nothing and is
 * judged only by whether the control's produced events land in the event log.
 */

/**
 * The VIOLATION TIER — MP-06/07, RS-03, PR-03/04/15, CP-05, DF-05's HR seam.
 * Every flow runs its violating case as well as its clean one: the refusals
 * ARE the controls, and each leaves durable evidence.
 */
async function runViolationTierLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.safe_mode"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  // ---- HR + custody (CP-05)
  await postEmployee(R({ id: "emp_t1", name: "Teller One", role: "teller", cash_handler: true }), env.db, "d", ops);
  await postEmployee(R({ id: "emp_t2", name: "Teller Two", role: "teller", cash_handler: true }), env.db, "d", ops);
  await postEmployeeTraining(R({ course: "cash_handling" }), "emp_t1", env.db, "d", ops);
  await postCashCustody(R({ employee_id: "emp_t1", kind: "key", asset_id: "casset_vault1" }), env.db, "d", ops);
  const cust = (env.rows["core.cash_custody"] ?? [])[0];
  // NEGATIVE: keybox without a second person is refused (dual control)
  await postCashKeyboxOpen(R({ reason: "solo attempt" }), String(cust?.id ?? "none"), env.db, "d", ops);
  await postCashKeyboxOpen(
    R({ second_person_id: "emp_t2", reason: "morning vault open" }),
    String(cust?.id ?? "none"), env.db, "d", ops,
  );
  await postCashCustodyAttest(R({ attested_by: "branch_mgr" }), String(cust?.id ?? "none"), env.db, "d", ops);
  // separation REVOKES the custody in the same act — CP-05's whole point
  await postEmployeeSeparate(R({ reason: "resigned" }), "emp_t1", env.db, "d", ops);

  // ---- MP-07 death + estate
  await postDeathReport(
    R({ date_of_death: "2026-07-01", death_certificate_ref: "dc_1" }),
    "ent_2", env.db, "d", ops,
  );
  await postEstateClaim(
    R({ claimant: "Executor Ed", date_of_death: "2026-07-01",
        death_certificate_ref: "dc_1", authority_document_ref: "letters_testamentary_1" }),
    "ent_2", env.db, "d", ops,
  );
  const claim = (env.rows["core.estate_claim"] ?? [])[0];
  // NEGATIVE: paying an unverified claimant is refused
  await postEstatePayout(R({}), String(claim?.id ?? "none"), env.db, env.cfg, "d", ops);
  await env.db.schema("core").from("verification")
    .update({ status: "approved" }).eq("id", String(claim?.verification_id ?? "none"));
  await postEstatePayout(R({ amounts_owed_cents: 5_000 }), String(claim?.id ?? "none"), env.db, env.cfg, "d", ops);

  // ---- MP-06 expulsion
  // NEGATIVE first: ent_4 has no contact on file — the notice cannot be
  // delivered, so the expulsion is refused rather than pretended
  await postExpulsion(
    R({ grounds: "fraud", decided_by: "board-2026-07", meeting_date: "2026-08-01" }),
    "ent_4", env.db, "d", ops,
  );
  await env.db.schema("core").from("entity")
    .update({ email: "member3@example.com" }).eq("id", "ent_3");
  const e3 = (env.rows["core.entity"] ?? []).find((r) => r.id === "ent_3");
  if (e3) e3.email = "member3@example.com";
  await postExpulsion(
    R({ grounds: "abuse of services", decided_by: "board-2026-07",
        meeting_date: "2026-08-01", amounts_owed_cents: 1_000 }),
    "ent_3", env.db, "d", ops,
  );
  const exp = (env.rows["core.expulsion"] ?? [])[0];
  await postExpulsionHearing(R({ kind: "requested" }), String(exp?.id ?? "none"), env.db, "d", ops);
  await postExpulsionHearing(R({ kind: "held" }), String(exp?.id ?? "none"), env.db, "d", ops);
  await postExpulsionClose(R({}), String(exp?.id ?? "none"), env.db, env.cfg, "d", ops);

  // ---- RS-03 safe mode
  await postSafeModeActivate(
    R({ trigger_basis: "resolution_drill", per_txn_cap_cents: 1_000_000,
        restricted_types: ["wire_transfer"], activated_by: "resolution_officer" }),
    env.db, "d", ops,
  );
  const sm = (env.rows["core.safe_mode"] ?? [])[0];
  await postSafeModeProcessorConfirm(R({ processor_ref: "proc_ack_1" }), String(sm?.id ?? "none"), env.db, "d", ops);
  // one allowed and one REFUSED transaction decision under safe mode
  await safeModeGate(env.db, 500_000, "transfer", "tr_sm_allowed", ops);
  await safeModeGate(env.db, 5_000_000, "transfer", "tr_sm_refused", ops);
  // NEGATIVE: one person twice is one person — deactivation refused
  await postSafeModeDeactivate(
    R({ authorized_by: "officer_a", second_authorizer: "officer_a" }),
    String(sm?.id ?? "none"), env.db, "d", ops,
  );
  await postSafeModeDeactivate(
    R({ authorized_by: "officer_a", second_authorizer: "officer_b" }),
    String(sm?.id ?? "none"), env.db, "d", ops,
  );

  // ---- PR-03 disclosures: two BLOCKS, then a recorded basis
  await postPrivacyDisclosure(R({ entity_id: "ent_1", recipient: "data_broker_x" }), env.db, "d", ops);
  await postPrivacyDisclosure(
    R({ entity_id: "ent_1", recipient: "vendor_y",
        legal_basis: "service_provider_glba", vendor_id: "vend_1" }),
    env.db, "d", ops,
  );
  await postPrivacyDisclosure(
    R({ entity_id: "ent_1", recipient: "vendor_y", legal_basis: "service_provider_glba",
        vendor_id: "vend_1", vendor_glba_addendum_id: "glba_add_7",
        vendor_contract_id: "contract_9", data_scope: ["name", "account_number"] }),
    env.db, "d", ops,
  );

  // ---- PR-04 access requests: the full decision surface
  await postPrivacyAccessRequest(R({ entity_id: "ent_1", requester_kind: "self" }), env.db, "d", ops);
  await postPrivacyAccessRequest(R({ entity_id: "ent_1", requester_kind: "agent_poa" }), env.db, "d", ops);
  await postPrivacyAccessRequest(
    R({ entity_id: "ent_1", requester_kind: "agent_poa",
        agent_identity: "Agent A", poa_artifact_id: "poa_1" }),
    env.db, "d", ops,
  );
  await postPrivacyAccessRequest(
    R({ entity_id: "ent_1", requester_kind: "legal_process",
        legal_process_artifact_id: "subpoena_1", rfpa_applicable: true }),
    env.db, "d", ops,
  );
  await postPrivacyAccessRequest(
    R({ entity_id: "ent_1", requester_kind: "other", agent_identity: "Nosy Neighbor" }),
    env.db, "d", ops,
  );

  // ---- PR-15 connection: consent -> token -> scope violation -> revoked
  await postPrivacyConnection(
    R({ entity_id: "ent_1", party_id: "budget_app_z", scopes: ["GET /accounts/{id}"] }),
    env.db, "d", ops,
  );
  const conn = (env.rows["core.connection"] ?? [])[0];
  await postConnectionScopeViolation(
    R({ attempted: "POST /transfers" }), String(conn?.id ?? "none"), env.db, "d", ops,
  );
}


/** Ops-security tail — EC-02/05/06/08/09, IS-05..14, BC-07/09/15. */
async function runOpsSecurityLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.backup_job"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  // HR base + access lifecycle (EC-02, IS-06)
  await postEmployee(R({ id: "emp_s1", name: "Sec One", role: "engineer" }), env.db, "d", ops);
  await postEmployee(R({ id: "emp_s2", name: "Sec Two", role: "oncall" }), env.db, "d", ops);
  await postEmployee(R({ id: "emp_s3", name: "Sec Gone", role: "contractor" }), env.db, "d", ops);
  await postAccessGrant(R({ user_id: "emp_s1", role: "admin" }), env.db, "d", ops);
  await postAccessGrant(R({ user_id: "emp_s2", role: "prod_db", breakglass: true }), env.db, "d", ops);
  await postAccessGrant(R({ user_id: "emp_s3", role: "repo" }), env.db, "d", ops);
  // separation deprovisions access in the same act (IS-06)
  await postEmployeeSeparate(R({ reason: "contract ended" }), "emp_s3", env.db, "d", ops);
  // NEGATIVE: granting to the separated employee is refused
  await postAccessGrant(R({ user_id: "emp_s3", role: "admin" }), env.db, "d", ops);
  const firstGrant = (env.rows["core.access_grant"] ?? [])[0];
  await postAccessDeprovision(R({ reason: "role change" }), String(firstGrant?.id ?? "none"), env.db, "d", ops);
  await postAccessReview(R({ reviewer: "ciso" }), env.db, "d", ops);

  // backups + restores (BC-07, IS-08)
  await postBackupCycle(R({ status: "completed", restore_point: "rp_2026_07_21" }), env.db, "d", ops);
  await postBackupCycle(R({ status: "failed" }), env.db, "d", ops);
  const jobs = env.rows["core.backup_job"] ?? [];
  const okJob = jobs.find((j) => j.status === "completed");
  const badJob = jobs.find((j) => j.status === "failed");
  // NEGATIVE: a restore test against the failed backup is refused
  await postRestoreTest(R({ backup_id: String(badJob?.id ?? "none") }), env.db, "d", ops);
  await postBackupRemediate(R({ action: "storage credentials rotated, job re-run" }), String(badJob?.id ?? "none"), env.db, "d", ops);
  await postRestoreTest(R({ backup_id: String(okJob?.id ?? "none") }), env.db, "d", ops);

  // TLS (EC-06, IS-07)
  await postTlsAssessment(R({ domain: "api.cassandra.bank", rating: "A", expires_at: "2026-08-01T00:00:00.000Z" }), env.db, "d", ops);
  const cert = (env.rows["core.tls_certificate"] ?? [])[0];
  await postTlsRenew(R({}), String(cert?.id ?? "none"), env.db, "d", ops);

  // reviews (EC-05, EC-08, EC-09)
  await postSecurityReview(R({ kind: "firewall", reviewer: "netops" }), env.db, "d", ops);
  // NEGATIVE: an "independent" review that does not attest independence
  await postSecurityReview(R({ kind: "firewall_independent", reviewer: "auditor" }), env.db, "d", ops);
  await postSecurityReview(R({ kind: "firewall_independent", reviewer: "auditor", independent: true }), env.db, "d", ops);
  await postSecurityReview(R({ kind: "antivirus_log", reviewer: "secops" }), env.db, "d", ops);
  await postSecurityReview(R({ kind: "incident_trend", reviewer: "secops", timeline: "quarterly" }), env.db, "d", ops);

  // vulnerabilities (IS-05)
  await postVulnFinding(R({ severity: "critical" }), env.db, "d", ops);
  const vuln = (env.rows["core.vuln_finding"] ?? [])[0];
  // NEGATIVE: remediation before triage is refused
  await postVulnRemediate(R({ fix: "patched" }), String(vuln?.id ?? "none"), env.db, "d", ops);
  await postVulnTriage(R({ outcome: "fix_now" }), String(vuln?.id ?? "none"), env.db, "d", ops);
  await postVulnRemediate(R({ fix: "patched openssl" }), String(vuln?.id ?? "none"), env.db, "d", ops);

  // SIEM (IS-14, EC-09)
  await postSiemAlert(R({ severity: "critical" }), env.db, "d", ops);
  const alert = (env.rows["core.siem_alert"] ?? [])[0];
  // NEGATIVE: disposal with no disposition is refused
  await postSiemDispose(R({}), String(alert?.id ?? "none"), env.db, "d", ops);
  await postSiemDispose(R({ disposition: "true positive, contained" }), String(alert?.id ?? "none"), env.db, "d", ops);
  await postSiemSourceSilent(R({}), "src_core_api", env.db, "d", ops);
  await postSiemSourceRestore(R({}), "src_core_api", env.db, "d", ops);

  // antivirus (EC-08)
  await postAntivirusEvent(R({ threat: "eicar_test" }), env.db, "d", ops);
  const av = (env.rows["core.antivirus_event"] ?? [])[0];
  await postAntivirusRemediate(R({ action: "quarantined" }), String(av?.id ?? "none"), env.db, "d", ops);

  // pentest (EC-05, EC-09)
  await postPentestEngagement(R({}), env.db, "d", ops);
  const pt = (env.rows["core.pentest_engagement"] ?? [])[0];
  await postPentestReport(R({ findings_count: 3 }), String(pt?.id ?? "none"), env.db, "d", ops);

  // AI governance (IS-13): the violating launch FIRST, then the lawful one
  await postAiTool(R({ name: "member-chat", member_facing: true }), env.db, "d", ops);
  const tool = (env.rows["core.ai_tool"] ?? [])[0];
  await postAiToolLaunch(R({}), String(tool?.id ?? "none"), env.db, "d", ops);
  await postAiToolDecision(R({ decision: "approved" }), String(tool?.id ?? "none"), env.db, "d", ops);
  await postAiToolLaunch(R({ data_scope: ["conversation_text"] }), String(tool?.id ?? "none"), env.db, "d", ops);
  await postAiTool(R({ name: "shadow-scoring" }), env.db, "d", ops);
  // find by name, not position: on the live tier the recorder also appends
  // UPDATE payloads (id-less), so rows[1] is not the second tool there
  const tool2 = (env.rows["core.ai_tool"] ?? []).find((t: Any) => t.name === "shadow-scoring");
  await postAiToolDecision(R({ decision: "rejected" }), String(tool2?.id ?? "none"), env.db, "d", ops);
  await postAiViolation(R({ description: "unapproved prompt logging" }), env.db, "d", ops);
  const aiv = (env.rows["core.ai_violation"] ?? [])[0];
  await postAiViolationDispose(R({ disposition: "logging disabled, tool suspended" }), String(aiv?.id ?? "none"), env.db, "d", ops);

  // DLP (IS-07)
  await postDlpViolation(R({ channel: "email", detail: "SSN pattern outbound" }), env.db, "d", ops);
  const dlpEv = (env.rows["core.event"] ?? []).find((e) => e.code === "dlp.violation.detected");
  const dlpId = String(dlpEv?.resource_id ?? "dlp_violation:none").split(":")[1];
  // NEGATIVE: resolution with no action is refused
  await postDlpResolve(R({}), dlpId, env.db, "d", ops);
  await postDlpResolve(R({ action: "message quarantined, sender counseled" }), dlpId, env.db, "d", ops);

  // incidents: intrusion (EC-09), containment discipline (BC-15), failover (BC-09)
  const compliance = { ...ops, tokenId: "tok_sec_compliance", roles: ["bsa_compliance"] };
  await postIncident(R({ id: "inc_drill_intrusion", title: "intrusion detected on edge", severity: "sev1", source: "siem" }), env.db, "d", compliance);
  const inc = (env.rows["core.incident"] ?? [])[0];
  const incId = String(inc?.id ?? "none");
  await postIntrusionResponse(R({ actions: "isolated host, rotated keys", detection_source: "siem", timeline: "t0+14m" }), incId, env.db, "d", ops);
  await postIncidentContainmentStart(R({ data_scope: ["none_confirmed"], description: "edge intrusion" }), incId, env.db, "d", compliance);
  // NEGATIVE: legal consulted by nobody is refused
  await postIncidentLegalConsult(R({}), incId, env.db, "d", compliance);
  await postIncidentLegalConsult(R({ counsel: "outside_counsel_1" }), incId, env.db, "d", compliance);
  await postIncidentVendorTracks(R({ vendors: ["cdn_vendor", "colo_vendor"] }), incId, env.db, "d", compliance);
  await postIncidentFailover(R({ decided_by: "ic_1", target: "region_b" }), incId, env.db, "d", compliance);
  await postIncidentMemberStatus(R({ statement: "services degraded; cards continue to work", member_impact: "online banking slow" }), incId, env.db, "d", compliance);
}

/** Liquidity ops tail + BA-08. */
async function runLiquidityOpsLifecycle(env: FireEnv): Promise<void> {
  if ((env.rows["core.ncua_notification"] ?? []).length > 0) return;
  const ops = env.actors.ops;

  await postAlcoRatioReview(R({ reviewed_by: "alco_chair", ratios: { lcr_bp: 12500 } }), env.db, "d", ops);
  // NEGATIVE: a breached concentration without a waiver decision is refused
  await postLiquidityConcentration(R({ top_depositor_pct_bp: 2600, limit_pct_bp: 2000 }), env.db, "d", ops);
  await postLiquidityConcentration(
    R({ top_depositor_pct_bp: 2600, limit_pct_bp: 2000,
        waiver_decision: "waived_90d", waiver_decided_by: "alco_chair" }),
    env.db, "d", ops,
  );
  await postEodTieout(R({ gl_total_cents: 1_000_000_00, subledger_total_cents: 999_950_00 }), env.db, "d", ops);
  await postModelReview(R({ model: "liquidity_stress_v3", reviewer: "risk_quant", outcome: "fit_for_use" }), env.db, "d", ops);

  await postNcuaNotification(R({ kind: "liquidity_event" }), env.db, "d", ops);
  const notif = (env.rows["core.ncua_notification"] ?? [])[0];
  // NEGATIVE: an acknowledgment without a reference is refused
  await postNcuaAck(R({}), String(notif?.id ?? "none"), env.db, "d", ops);
  await postNcuaAck(R({ ack_ref: "ncua_ack_2026_0721" }), String(notif?.id ?? "none"), env.db, "d", ops);

  await postRegulatorRequest(R({ regulator: "NCUA" }), env.db, "d", ops);
  const rr = (env.rows["core.regulator_request"] ?? [])[0];
  await postRegulatorResponse(R({ response_ref: "resp_2026_0721" }), String(rr?.id ?? "none"), env.db, "d", ops);
  await postRegulatorContactsVerify(R({ verified_by: "cfo" }), String(rr?.id ?? "none"), env.db, "d", ops);

  await postWholesaleExposure(
    R({ amount_cents: 500_000_00, rate_bp: 620, market_rate_bp: 540, listing_decision: "approved" }),
    env.db, "d", ops,
  );

  // BA-08: pillar 3 with a shortfall period + the capital training cycle
  await postPillar3Disclosure(
    R({ period: "2026-Q2", board_minutes_ref: "minutes_2026_07_board", shortfall: true }),
    env.db, "d", ops,
  );
  await postEmployee(R({ id: "emp_l1", name: "Cap Analyst", role: "finance" }), env.db, "d", ops);
  await postTrainingAssignment(
    R({ curriculum: "capital", assignee_id: "emp_l1" }),
    env.db, "d", ops,
  );
}

export const FIRERS: Record<string, (env: FireEnv, uid: string) => Promise<void>> = {
  // ---- ops-security tail (EC/IS/BC)
  "access.granted": (env) => runOpsSecurityLifecycle(env),
  "access.review.due_at": (env) => runOpsSecurityLifecycle(env),
  "access.deprovisioned": (env) => runOpsSecurityLifecycle(env),
  "access.breakglass.used": (env) => runOpsSecurityLifecycle(env),
  "backup.cycle.completed": (env) => runOpsSecurityLifecycle(env),
  "backup.restore.test.due": (env) => runOpsSecurityLifecycle(env),
  "backup.job.failed": (env) => runOpsSecurityLifecycle(env),
  "firewall.review.due": (env) => runOpsSecurityLifecycle(env),
  "firewall.independent.review.due": (env) => runOpsSecurityLifecycle(env),
  "tls.assessment.due": (env) => runOpsSecurityLifecycle(env),
  "tls.certificate.expiry.due": (env) => runOpsSecurityLifecycle(env),
  "tls.certificate_expires_at": (env) => runOpsSecurityLifecycle(env),
  "antivirus.remediated": (env) => runOpsSecurityLifecycle(env),
  "antivirus.log.review.due": (env) => runOpsSecurityLifecycle(env),
  "intrusion.detected": (env) => runOpsSecurityLifecycle(env),
  "siem.alert.review.due_at": (env) => runOpsSecurityLifecycle(env),
  "siem.alert_critical": (env) => runOpsSecurityLifecycle(env),
  "siem.source_silent": (env) => runOpsSecurityLifecycle(env),
  "pentest.engagement_due": (env) => runOpsSecurityLifecycle(env),
  "incident_trend.review.due": (env) => runOpsSecurityLifecycle(env),
  "vuln.finding.confirmed": (env) => runOpsSecurityLifecycle(env),
  "dlp.violation.detected": (env) => runOpsSecurityLifecycle(env),
  "vuln.triage.completed": (env) => runOpsSecurityLifecycle(env),
  "ai.tool.proposed": (env) => runOpsSecurityLifecycle(env),
  "ai.tool.approved": (env) => runOpsSecurityLifecycle(env),
  "ai.member_feature.launched": (env) => runOpsSecurityLifecycle(env),
  "ai.violation.disposed": (env) => runOpsSecurityLifecycle(env),
  "incident.containment.started": (env) => runOpsSecurityLifecycle(env),
  "vendor.incident.logged": (env) => runOpsSecurityLifecycle(env),
  "it.major_failure.detected": (env) => runOpsSecurityLifecycle(env),
  "it.failover.decided": (env) => runOpsSecurityLifecycle(env),
  // ---- liquidity ops tail + BA-08
  "alco.ratio_review.logged": (env) => runLiquidityOpsLifecycle(env),
  "liquidity.depositor_file.posted": (env) => runLiquidityOpsLifecycle(env),
  "dq.variance.detected": (env) => runLiquidityOpsLifecycle(env),
  "model.review.due_at": (env) => runLiquidityOpsLifecycle(env),
  "ncua.notification_required": (env) => runLiquidityOpsLifecycle(env),
  "ncua.ack.received": (env) => runLiquidityOpsLifecycle(env),
  "ncua.notification.sent": (env) => runLiquidityOpsLifecycle(env),
  "regulator.contact.verification.due": (env) => runLiquidityOpsLifecycle(env),
  "wholesale.exposure.posted": (env) => runLiquidityOpsLifecycle(env),
  "wholesale.listing.requested": (env) => runLiquidityOpsLifecycle(env),
  "disclosure.pillar3.published": (env) => runLiquidityOpsLifecycle(env),
  "training.capital_cycle.started": (env) => runLiquidityOpsLifecycle(env),
  // ---- violation tier (MP/RS/PR/CP-05 + HR seam)
  "employee.hired": (env) => runViolationTierLifecycle(env),
  "employee.separated": (env) => runViolationTierLifecycle(env),
  "cash.custody.rotation_due_at": (env) => runViolationTierLifecycle(env),
  "cash.keybox.opened": (env) => runViolationTierLifecycle(env),
  "cash.dual_control.completed": (env) => runViolationTierLifecycle(env),
  "cash.coverage_change.requested": (env) => runViolationTierLifecycle(env),
  "safe_mode.triggered": (env) => runViolationTierLifecycle(env),
  "safe_mode.activated": (env) => runViolationTierLifecycle(env),
  "safe_mode.transaction.decided": (env) => runViolationTierLifecycle(env),
  "safe_mode.deactivation.authorized": (env) => runViolationTierLifecycle(env),
  "disclosure.initiated": (env) => runViolationTierLifecycle(env),
  "vendor.glba_clause.verified": (env) => runViolationTierLifecycle(env),
  "privacy.sharing.blocked": (env) => runViolationTierLifecycle(env),
  "access.request.received": (env) => runViolationTierLifecycle(env),
  "access.poa.presented": (env) => runViolationTierLifecycle(env),
  "access.refused": (env) => runViolationTierLifecycle(env),
  "legal.process.received": (env) => runViolationTierLifecycle(env),
  "connection.consent.granted": (env) => runViolationTierLifecycle(env),
  "connection.scope_violation.detected": (env) => runViolationTierLifecycle(env),
  "connection.revoke.requested": (env) => runViolationTierLifecycle(env),
  "insider.credit_threshold_exceeded": (env) => runLendingUwLifecycle(env),
  "insider.credit.extended": (env) => runLendingUwLifecycle(env),
  "insider.limits_recomputed": (env) => runLendingUwLifecycle(env),
  "account.closed": async (env) => {
    const id = `acct_f${env.n()}`;
    // client write, not env.rows: the transition below reads the account back
    // from the database (no provenance — core.account predates the column)
    await env.db.schema("core").from("account").upsert({
      id, entity_id: "ent_1", status: "open", lock_type: "none",
      account_type: "checking", balance: 100000, blnk_balance_id: "b", partner_id: "ptnr_drill",
    }, { onConflict: "id" });
    await postAccountTransition(R({ to: "closed" }), id, env.db, "d", env.actors.ops);
    await setRetentionClocks(env.db, id, new Date());
  },
  "entity.created": async (env) => {
    await postEntity(
      R({ type: "person", name: drillPersona(env.n()), date_of_birth: "1990-01-01" }),
      env.db, "d", env.actors.ops,
    );
  },
  "entity.updated": async (env) => {
    const n = env.n();
    const id = `ent_u${n}`;
    await env.db.schema("core").from("entity").upsert(
      { id, type: "person", name: drillPersona(n), status: "pending", partner_id: "ptnr_drill" },
      { onConflict: "id" },
    );
    await postEntityTransition(R({ to: "active" }), id, env.db, "d", env.actors.ops);
  },
  "verification.created": async (env) => {
    await runBsaProgramLifecycle(env);
    const n = env.n();
    const id = `ent_v${n}`;
    await env.db.schema("core").from("entity").upsert(
      { id, type: "person", name: drillPersona(n), status: "pending", partner_id: "ptnr_drill" },
      { onConflict: "id" },
    );
    await postVerification(R({}), id, env.db, "d", env.actors.ops);
  },
  "bsa_alert.created": async (env, uid) => {
    await raiseAlert(env.db, {
      ctx: env.actors.ops, alertType: "ctr_threshold", entityHash: "h",
      causeType: "transfer", causeId: `t${env.n()}`, details: uid,
    });
  },
  "case.investigation_complete": async (env) => {
    await runBsaProgramLifecycle(env);
    const n = env.n();
    await raiseAlert(env.db, {
      ctx: env.actors.ops, alertType: "structuring", entityHash: "h",
      causeType: "transfer", causeId: `ci${n}`, details: "d",
    });
    const res = await postAlertTriage(
      R({ outcome: "escalated" }), `alert_ci${n}_structuring`, env.db, "d", env.actors.investigator,
    );
    const b = await res.clone().json().catch(() => ({}));
    if (b?.case?.id) {
      await postCaseDecision(
        R({ decision: "file", rationale: "drill" }), b.case.id, env.db, "d", env.actors.officer,
      );
    }
  },
  "ctr.threshold.reached": async (env) => {
    await runBsaProgramLifecycle(env);
    const d = `2026-07-${String(10 + (env.n() % 15)).padStart(2, "0")}`;
    await postCashTransaction(
      R({ direction: "cash_in", amount_cents: 1_200_000, business_date: d, account_id: "acct_1" }),
      env.db, "d", env.actors.ops,
    );
  },
  "legal_hold.created": async (env) => {
    const n = env.n();
    const subj = `acct_h${n}`;
    // fixture THROUGH the client — a pushed row only ages the fake's copy
    await env.db.schema("core").from("record").upsert({
      id: `rec_${subj}_cip_identity`, record_class: "cip_identity", subject_ref: subj,
      retention_anchor: "2014-01-01T00:00:00.000Z", retention_anchor_kind: "account_closed",
      retention_expires_at: "2019-01-01T00:00:00.000Z",
      legal_hold_flag: false, disposed_at: null, provenance: "production",
    }, { onConflict: "id" });
    // the FULL SC-02 lifecycle: place -> release -> dispose. All three phases
    // are needed because SC-02 declares consequences from each.
    await postLegalHold(R({ matter_id: `m${n}`, scope_subject_ref: subj, reason: "drill" }), env.db, "d", env.actors.ops);
    await postHoldRelease(R({ approved_by: "gc" }), `hold_m${n}_${subj}`, env.db, "d", env.actors.ops);
    // the sweep is what SCHEDULES disposal — a real step in SC-02, not a
    // formality: it is where the three eligibility conditions are evaluated
    await postDisposalSweep(R({}), env.db, "d", env.actors.ops);
    await postDisposeRecord(
      R({ approved_by: "rm", certificate: `cert${n}` }), `rec_${subj}_cip_identity`,
      env.db, "d", env.actors.ops,
    );
  },
  "legal_hold.clear.confirmed": (env, uid) => FIRERS["legal_hold.created"](env, uid),
  "disposal.executed": async (env) => {
    const id = `rec_d${env.n()}`;
    // RR-03 declares `disposal.scheduled`, which is emitted by the SWEEP — the
    // step that evaluates the three eligibility conditions. Disposing directly
    // skipped it, so RR-03 read red for a missing event that the system does
    // in fact produce, just not on this path.
    // fixture THROUGH the client — a pushed row ages the fake's copy and
    // leaves a real database untouched (the live tier read these controls red)
    //
    // retention_anchor_kind is NOT NULL in the real schema and was absent
    // here, so every live insert failed on 23502 — unchecked, so the sweep
    // then found nothing to schedule and the disposal 404'd, and FOURTEEN
    // controls across ten policies read red for events whose writers were
    // complete all along. The error is checked now: a fixture that fails to
    // land must fail loudly, not grade the control it was meant to exercise.
    const { error: fixErr } = await env.db.schema("core").from("record").insert({
      id, record_class: "cip_identity", subject_ref: "acct_9",
      retention_anchor: "2014-01-01T00:00:00.000Z",
      retention_anchor_kind: "account_closed",
      retention_expires_at: "2019-01-01T00:00:00.000Z",
      legal_hold_flag: false, disposed_at: null, provenance: "demo",
    });
    if (fixErr) throw new Error(`retention fixture ${id}: ${fixErr.message}`);
    await postDisposalSweep(R({}), env.db, "d", env.actors.ops);
    await postDisposeRecord(R({ approved_by: "rm", certificate: "c" }), id, env.db, "d", env.actors.ops);
  },
  "record.disposal_eligible": async (env) => { await FIRERS["disposal.executed"](env, ""); },
  "record.hold.applied": (env, uid) => FIRERS["legal_hold.created"](env, uid),
  "record.hold.placed": (env, uid) => FIRERS["legal_hold.created"](env, uid),
  "record.hold.released": (env, uid) => FIRERS["legal_hold.clear.confirmed"](env, uid),
  // RR-07 (BSA anonymization) and SC-02 (the shared lifecycle) BOTH declare
  // this trigger and need different halves of the system: SC-02 needs the
  // disposal path, RR-07 needs the disposition METHOD. Firing only one graded
  // the other against machinery it does not use.
  "record.retention.expires_at": (env) => runPrivacyLifecycle(env),
  "record.retention.expired": async (env, uid) => {
    await runPrivacyLifecycle(env);
    await FIRERS["disposal.executed"](env, uid);
    await runRecordsAdminLifecycle(env);
  },
  // RR-01 and RR-11 hang off record.created and need the SCHEDULE, not just a
  // disposal. Routing this to the disposal firer graded them against machinery
  // that never consults Schedule A.
  "record.created": (env) => runRecordsAdminLifecycle(env),
  /**
   * SC-02's full lifecycle in one pass. The retention controls are the SAME
   * shared control replicated into 11 policies, so one honest run of
   * place-hold -> release -> dispose satisfies all of them at once.
   */
  "legal_hold.placed": (env, uid) => FIRERS["legal_hold.created"](env, uid),
  "ach_transfer.created": async (env) => {
    await postAch(
      R({ source_account_id: "acct_2", amount_cents: 5_000, counterparty: { name: "V" } }),
      env.db, env.cfg, "d", env.actors.ops,
    );
  },
  "wire_transfer.submitted": async (env) => {
    await runBsaProgramLifecycle(env);
    await postWirePrepare(
      R({ source_account_id: "acct_3", amount_cents: 5_000, beneficiary: { name: "B", country: "US" } }),
      env.db, env.cfg, "d", env.actors.ops,
    );
  },
  "loan_party.added": async (env) => {
    await postLoanParty(
      R({
        role: "borrower", party_name: `P${env.n()}`,
        identity: { tin_last4: "1234", dob: "1980-01-01" },
        contact: { email: "p@example.test", phone: "+15550100" },
      }),
      "app_1", env.db, "d", env.actors.ops,
    );
    // LP-11 declares the SCREEN OUTCOMES as separate facts — screened, cleared,
    // potential match, escalated. The gate emitted only the escalation, so a
    // CLEAN screen left no evidence it had run: "not escalated" and "never
    // screened" produced the same event log. Same defect the OFAC floor was
    // built to avoid on the payment rails.
    await postLoanParty(
      R({ role: "guarantor", party_name: "SDN Suspect" }), "app_1", env.db, "d", env.actors.ops,
    );
  },
  "loan_party.ofac.cleared": (env, uid) => FIRERS["loan_party.added"](env, uid),
  "loan_party.ofac.escalated": (env, uid) => FIRERS["loan_party.added"](env, uid),
  "loan_application.completed": async (env) => {
    const id = `app_f${env.n()}`;
    await env.db.schema("core").from("loan_application").upsert({
      id, status: "completed", completed_at: "2026-06-01T00:00:00.000Z",
      decisioned_at: null, final_action: null, funding_block_state: "open", provenance: "production",
    }, { onConflict: "id" });
  },
  "application.final_action.recorded": async (env) => {
    const id = `app_fa${env.n()}`;
    await env.db.schema("core").from("loan_application").upsert({
      id, status: "completed", completed_at: "2026-06-01T00:00:00.000Z",
      decisioned_at: null, final_action: null, funding_block_state: "open", provenance: "production",
    }, { onConflict: "id" });
    await postLoanDecision(
      R({ final_action: "denied", reasons: ["drill"] }), id, env.db, "d", env.actors.ops,
    );
    await postAanIssue(R({}), `aan_${id}`, env.db, "d", env.actors.reviewer);
  },
  "aan.second_review.completed": async (env) => {
    await FIRERS["application.final_action.recorded"](env, "");
  },
  "audit.plan_cycle.opened": (env) => runAuditLifecycle(env),
  "audit.annual_plan.submitted": (env) => runAuditLifecycle(env),
  "audit.engagement.started": (env) => runAuditLifecycle(env),
  "audit.fieldwork.completed": (env) => runAuditLifecycle(env),
  "audit.report.issued": (env) => runAuditLifecycle(env),
  "audit.report.submitted": (env) => runAuditLifecycle(env),
  "audit.scope_change.identified": (env) => runAuditLifecycle(env),
  "audit.poor_rating.recorded": (env) => runAuditLifecycle(env),
  "finding.opened": (env) => runAuditLifecycle(env),
  "finding.monthly_review.recorded": (env) => runAuditLifecycle(env),
  "finding.aging_threshold.breached": (env) => runAuditLifecycle(env),
  "finding.quarterly_report.delivered": (env) => runAuditLifecycle(env),
  "finding.management_response.recorded": (env) => runAuditLifecycle(env),
  "finding.risk_acceptance.proposed": (env) => runAuditLifecycle(env),
  "risk_acceptance.decided": (env) => runAuditLifecycle(env),
  "finding.remediation.reported": (env) => runAuditLifecycle(env),
  "finding.closure.verified": (env) => runAuditLifecycle(env),
  "finding.closure.rejected": (env) => runAuditLifecycle(env),
  "audit.committee_meeting.scheduled": (env) => runAuditLifecycle(env),
  "audit.external_engagement.proposed": (env) => runAuditLifecycle(env),
  "audit.workpaper_access.requested": (env) => runAuditLifecycle(env),
  "audit.workpaper_access.decided": (env) => runAuditLifecycle(env),
  "audit.cycle_timer": (env) => runAuditLifecycle(env),
  "audit.remediation.due": (env) => runAuditLifecycle(env),
  "audit.report_issued": (env) => runAuditLifecycle(env),
  "capital.ratios.verified": (env) => runCapitalLifecycle(env),
  "capital.pca_threshold.breached": (env) => runCapitalLifecycle(env),
  "capital.quarter_close": (env) => runCapitalLifecycle(env),
  "capital.target.breached": (env) => runCapitalLifecycle(env),
  "capital.contingency.activated": (env) => runCapitalLifecycle(env),
  "capital.components.classified": (env) => runCapitalLifecycle(env),
  "capital.instrument.changed": (env) => runCapitalLifecycle(env),
  "capital.buffer_status.recorded": (env) => runCapitalLifecycle(env),
  "capital.stress_report.issued": (env) => runCapitalLifecycle(env),
  "capital.action_board.decided": (env) => runCapitalLifecycle(env),
  "capital.internal_trigger.breached": (env) => runCapitalLifecycle(env),
  "capital.plan.prepared": (env) => runCapitalLifecycle(env),
  "capital.distribution_restriction.applied": (env) => runCapitalLifecycle(env),
  "rwa.mapping_run.started": (env) => runCapitalLifecycle(env),
  "rwa.exposure.classified": (env) => runCapitalLifecycle(env),
  // Both capital (BA-*) and investment (IP-02/IP-12) declare these. The capital
  // report and the portfolio report are different documents that happen to
  // share a code, so both lifecycles run rather than one being picked.
  "portfolio.board_report.issued": async (env) => {
    await runCapitalLifecycle(env);
    await runInvestmentLifecycle(env);
  },
  "portfolio.management_report.issued": async (env) => {
    await runCapitalLifecycle(env);
    await runInvestmentLifecycle(env);
  },
  "stress.quarter_open": (env) => runCapitalLifecycle(env),
  "stress.scenario.run": (env) => runCapitalLifecycle(env),
  "capital.report.quarter_close": (env) => runCapitalLifecycle(env),
  "capital.plan.updated": (env) => runCapitalLifecycle(env),
  "capital.plan.presented": (env) => runCapitalLifecycle(env),
  "capital.plan.reviewed": (env) => runCapitalLifecycle(env),
  "capital.quarterly_report.issued": (env) => runCapitalLifecycle(env),
  "capital.quarterly_report.reviewed": (env) => runCapitalLifecycle(env),
  "capital.contingency_memo.issued": (env) => runCapitalLifecycle(env),
  "capital.board_escalation.issued": (env) => runCapitalLifecycle(env),
  "capital.contingency_action.executed": (env) => runCapitalLifecycle(env),
  "capital.action.proposed": (env) => runCapitalLifecycle(env),
  "capital.action.executed": (env) => runCapitalLifecycle(env),
  "capital.icaap_cycle.opened": (env) => runCapitalLifecycle(env),
  "capital.icaap_report.issued": (env) => runCapitalLifecycle(env),
  "capital.icaap.presented": (env) => runCapitalLifecycle(env),
  "capital.icaap.reviewed": (env) => runCapitalLifecycle(env),
  "capital.buffer.breached": (env) => runCapitalLifecycle(env),
  "rwa.trading_threshold_crossed": (env) => runCapitalLifecycle(env),
  "capital.credit_growth_threshold_crossed": (env) => runCapitalLifecycle(env),
  "capital.stress_report_id": (env) => runCapitalLifecycle(env),
  "stress_test.completed": (env) => runCapitalLifecycle(env),
  "capital.targets.approved": (env) => runCapitalLifecycle(env),
  "eps.auth.decided": (env) => runEpsAuthFraud(env),
  "eps.auth_lockout.applied": (env) => runEpsAuthFraud(env),
  "eps.auth.challenged": (env) => runEpsAuthFraud(env),
  "eps.card_control.applied": (env) => runEpsAuthFraud(env),
  "eps.card_control.changed": (env) => runEpsAuthFraud(env),
  "eps.pospay_exception.presented": (env) => runEpsAuthFraud(env),
  "eps.pospay_exception.decided": (env) => runEpsAuthFraud(env),
  "eps.fraud_trend_review.completed": (env) => runEpsAuthFraud(env),
  "eps.auth.failure_count": (env) => runEpsAuthFraud(env),
  // Every cda trigger runs the one programme lifecycle. Three of these
  // (`*_cycle.opened`) would otherwise match TIMER_RE and be fired through the
  // governance calendar, which would register an obligation and emit nothing a
  // CDA control declares — a control can only pass here by the programme
  // actually running.
  "cda.audit_cycle.opened": (env) => runCdaLifecycle(env),
  "cda.policy.expired": (env) => runCdaLifecycle(env),
  "cda.quarter.closed": (env) => runCdaLifecycle(env),
  "cda.month.closed": (env) => runCdaLifecycle(env),
  "cda.call_report_cycle.opened": (env) => runCdaLifecycle(env),
  "cda.glossary_change.proposed": (env) => runCdaLifecycle(env),
  "cda.evidence_packet.filed": (env) => runCdaLifecycle(env),
  "cda.vendor_onboarding.started": (env) => runCdaLifecycle(env),
  "cda.vendor_review.completed": (env) => runCdaLifecycle(env),
  "cda.vendor_issue.flagged": (env) => runCdaLifecycle(env),
  "cda.agreement.submitted": (env) => runCdaLifecycle(env),
  "cda.agreement_amendment.proposed": (env) => runCdaLifecycle(env),
  "cda.cap_test.scheduled": (env) => runCdaLifecycle(env),
  "cda.funding.requested": (env) => runCdaLifecycle(env),
  "cda.cap.breached": (env) => runCdaLifecycle(env),
  "cda.trade.proposed": (env) => runCdaLifecycle(env),
  "cda.posttrade_check.scheduled": (env) => runCdaLifecycle(env),
  "cda.distribution.proposed": (env) => runCdaLifecycle(env),
  "cda.distribution_cycle.opened": (env) => runCdaLifecycle(env),
  "cda.audit_finding.logged": (env) => runCdaLifecycle(env),
  "cda.termination.approved": (env) => runCdaLifecycle(env),
  "cda.inkind_transfer.proposed": (env) => runCdaLifecycle(env),
  "cda.account.closed": (env) => runCdaLifecycle(env),
  "cda.fee_payment.proposed": (env) => runCdaLifecycle(env),
  "cda.fee_conflict.flagged": (env) => runCdaLifecycle(env),
  "cda.communication.drafted": (env) => runCdaLifecycle(env),
  "cda.communication.published": (env) => runCdaLifecycle(env),
  "policy.board_review.started": (env) => runCashOpsLifecycle(env),
  "cash.governance_quarter.closed": (env) => runCashOpsLifecycle(env),
  "cash.kri_month.closed": (env) => runCashOpsLifecycle(env),
  "cash.exception.logged": (env) => runCashOpsLifecycle(env),
  "cash.enterprise_position.posted": (env) => runCashOpsLifecycle(env),
  "cash.enterprise_limit.warning": (env) => runCashOpsLifecycle(env),
  "cash.enterprise_limit.breached": (env) => runCashOpsLifecycle(env),
  "cash.limits_schedule.updated": (env) => runCashOpsLifecycle(env),
  "cash.load.requested": (env) => runCashOpsLifecycle(env),
  "cash.dual_control.initiated": (env) => runCashOpsLifecycle(env),
  "cash.recon_day.closed": (env) => runCashOpsLifecycle(env),
  "cash.recon.variance_found": (env) => runCashOpsLifecycle(env),
  "gl.cash_suspense.aged": (env) => runCashOpsLifecycle(env),
  "gl.cash_suspense.cleared": (env) => runCashOpsLifecycle(env),
  "cash.overshort.recorded": (env) => runCashOpsLifecycle(env),
  "cash.overshort.resolved": (env) => runCashOpsLifecycle(env),
  "cash.overshort.threshold_crossed": (env) => runCashOpsLifecycle(env),
  "cash.overshort_anomaly.detected": (env) => runCashOpsLifecycle(env),
  "cash.nightdrop.retrieved": (env) => runCashOpsLifecycle(env),
  "cash.shipment.received": (env) => runCashOpsLifecycle(env),
  "cash.shipment.verified": (env) => runCashOpsLifecycle(env),
  "cash.seal.mismatch": (env) => runCashOpsLifecycle(env),
  "cash.surprise_count.due": (env) => runCashOpsLifecycle(env),
  "cash.surprise_count.completed": (env) => runCashOpsLifecycle(env),
  "supervisory.count_results.delivered": (env) => runCashOpsLifecycle(env),
  "exam.export.requested": (env) => runCashOpsLifecycle(env),
  "cash.deviation.requested": (env) => runCashOpsLifecycle(env),
  "cash.deviation.approved": (env) => runCashOpsLifecycle(env),
  "cash.deviation.expired": (env) => runCashOpsLifecycle(env),
  "cash.evidence.created": (env) => runCashOpsLifecycle(env),
  // CP-05 (`employee.separated`, `cash.custody.*`, `cash.keybox.*`) and the
  // `hr.*` half of CP-07 are deliberately NOT registered. Those need an
  // employee, and inventing one to turn a control green is the error the
  // standing rule in BLUEPRINT forbids.
  "record_class.unmatched": (env) => runRecordsAdminLifecycle(env),
  "schedule_a.entry.amended": (env) => runRecordsAdminLifecycle(env),
  "record.media_converted": (env) => runRecordsAdminLifecycle(env),
  "record.integrity.test.due": (env) => runRecordsAdminLifecycle(env),
  "record.integrity_test.completed": (env) => runRecordsAdminLifecycle(env),
  "storage_box.created": (env) => runRecordsAdminLifecycle(env),
  "destruction_log.mismatch.detected": (env) => runRecordsAdminLifecycle(env),
  "destruction_log.mismatch.resolved": (env) => runRecordsAdminLifecycle(env),
  "records.annual.review.due_at": (env) => runRecordsAdminLifecycle(env),
  "core_archive.confirmation_due": (env) => runRecordsAdminLifecycle(env),
  "email_archive.test.due": (env) => runRecordsAdminLifecycle(env),
  "email_archive.test.completed": (env) => runRecordsAdminLifecycle(env),
  "cdd.refresh.due": (env) => runRecordsAdminLifecycle(env),
  "cdd.profile.refreshed": (env) => runRecordsAdminLifecycle(env),
  "regulation.retention_change.detected": (env) => runRecordsAdminLifecycle(env),
  "records.policy_review.completed": (env) => runRecordsAdminLifecycle(env),
  "records.contacts.assigned": (env) => runRecordsAdminLifecycle(env),
  "records.contact_vacated": (env) => runRecordsAdminLifecycle(env),
  "records.board_report.filed": (env) => runRecordsAdminLifecycle(env),
  // Lending underwriting. `loan.booking.requested` IS registered now: it needs
  // core.loan, one of the 22 abandoned tables, and building the booking writer
  // was the whole point of the abandoned-table finding.
  "loan.booking.requested": async (env) => {
    await runLendingUwLifecycle(env);
    await runCollectionsLifecycle(env);
  },
  "aan.issued": (env) => runLendingUwLifecycle(env),
  "analytics.disparity_report.completed": (env) => runLendingUwLifecycle(env),
  "analytics.redlining_review.completed": (env) => runLendingUwLifecycle(env),
  "appraisal.completed": (env) => runLendingUwLifecycle(env),
  "appraisal.ordered": (env) => runLendingUwLifecycle(env),
  "collateral.ltv.checked": (env) => runLendingUwLifecycle(env),
  "credit_config.changed": (env) => runLendingUwLifecycle(env),
  "credit_package.retention.started": (env) => runLendingUwLifecycle(env),
  "credit_report.received": (env) => runLendingUwLifecycle(env),
  "credit_score.tolerance.breached": (env) => runLendingUwLifecycle(env),
  "fair_lending.discouragement.reported": (env) => runLendingUwLifecycle(env),
  "fair_lending.remediation.opened": (env) => runLendingUwLifecycle(env),
  "hmda.lar_qc.completed": (env) => runLendingUwLifecycle(env),
  "insider.board_approval.recorded": (env) => runLendingUwLifecycle(env),
  "insider.board_report.issued": (env) => runLendingUwLifecycle(env),
  "loan_account.adverse_action.decided": (env) => runLendingUwLifecycle(env),
  "loan_application.adverse_action.decided": (env) => runLendingUwLifecycle(env),
  "loan_application.counteroffer.expired": (env) => runLendingUwLifecycle(env),
  "loan_application.created": (env) => runLendingUwLifecycle(env),
  "loan_application.decisioned": (env) => runLendingUwLifecycle(env),
  "loan_application.dti.breached": (env) => runLendingUwLifecycle(env),
  "loan_application.incomplete.detected": (env) => runLendingUwLifecycle(env),
  "loan_application.insider.flagged": (env) => runLendingUwLifecycle(env),
  "loan_application.insider.screened": (env) => runLendingUwLifecycle(env),
  "loan_application.oral_adverse_decision": (env) => runLendingUwLifecycle(env),
  "loan_application.thin_file.flagged": (env) => runLendingUwLifecycle(env),
  "loan_exception.analytics.published": (env) => runLendingUwLifecycle(env),
  "loan_exception.decided": (env) => runLendingUwLifecycle(env),
  "loan_exception.detected": (env) => runLendingUwLifecycle(env),
  "loan_exception.submitted": (env) => runLendingUwLifecycle(env),
  "loan_pricing.exception.decided": (env) => runLendingUwLifecycle(env),
  "loan_pricing.exception.requested": (env) => runLendingUwLifecycle(env),
  "loan_pricing.locked": (env) => runLendingUwLifecycle(env),
  "prequal.requested": (env) => runLendingUwLifecycle(env),
  "pricing.exception_period.closed": (env) => runLendingUwLifecycle(env),
  "product_menu.change.requested": (env) => runLendingUwLifecycle(env),
  "product_menu.deployed": (env) => runLendingUwLifecycle(env),
  "rate_sheet.refresh.due_at": (env) => runLendingUwLifecycle(env),
  "steering_review.completed": (env) => runLendingUwLifecycle(env),
  "valuation.rov.requested": (env) => runLendingUwLifecycle(env),
  "trade.limit.blocked": (env) => runInvestmentLifecycle(env),
  "trade.exception.logged": (env) => runInvestmentLifecycle(env),
  "intermediary.review.completed": (env) => runInvestmentLifecycle(env),
  "trade.permissibility.checked": (env) => runInvestmentLifecycle(env),
  "trade.limit_warning.issued": (env) => runInvestmentLifecycle(env),
  "instrument_list.review.completed": (env) => runInvestmentLifecycle(env),
  "regulatory.change_analysis.logged": (env) => runInvestmentLifecycle(env),
  "position.booked": (env) => runInvestmentLifecycle(env),
  "alm.irr_simulation.completed": (env) => runInvestmentLifecycle(env),
  "stress_test.minimum.breached": (env) => runInvestmentLifecycle(env),
  "credit_file.approved": (env) => runInvestmentLifecycle(env),
  "credit_file.reanalysis.completed": (env) => runInvestmentLifecycle(env),
  "security.downgraded": (env) => runInvestmentLifecycle(env),
  "security.downgrade.reviewed": (env) => runInvestmentLifecycle(env),
  "liquidity.report.published": (env) => runInvestmentLifecycle(env),
  "liquidity.stress.declared": (env) => runInvestmentLifecycle(env),
  "position.liquidity.classified": (env) => runInvestmentLifecycle(env),
  "limit_set.review.completed": (env) => runInvestmentLifecycle(env),
  "concentration.limit_exceeded": (env) => runInvestmentLifecycle(env),
  "trade.intermediary.blocked": (env) => runInvestmentLifecycle(env),
  "safekeeping.reconciliation.completed": (env) => runInvestmentLifecycle(env),
  "repo.booked": (env) => runInvestmentLifecycle(env),
  "repo.collateral_marked": (env) => runInvestmentLifecycle(env),
  "repo.margin_shortfall.detected": (env) => runInvestmentLifecycle(env),
  "security.fair_value.updated": (env) => runInvestmentLifecycle(env),
  "security.otti_analysis.completed": (env) => runInvestmentLifecycle(env),
  "trade.checklist.completed": (env) => runInvestmentLifecycle(env),
  "trade.checklist_exception_raised": (env) => runInvestmentLifecycle(env),
  "portfolio.stress_test.completed": (env) => runInvestmentLifecycle(env),
  "performance.attribution.completed": (env) => runInvestmentLifecycle(env),
  "performance.target_change.proposed": (env) => runInvestmentLifecycle(env),
  "trade.sod.blocked": (env) => runInvestmentLifecycle(env),
  "trade.confirmation.received": (env) => runInvestmentLifecycle(env),
  "trade.confirmation_discrepancy.flagged": (env) => runInvestmentLifecycle(env),
  "trade.reconciliation.completed": (env) => runInvestmentLifecycle(env),
  "trade.step.recorded": (env) => runInvestmentLifecycle(env),
  "document.required_set": (env) => runInvestmentLifecycle(env),
  "document.attachment_due_at": (env) => runInvestmentLifecycle(env),
  "cfp.investment_test.completed": (env) => runInvestmentLifecycle(env),
  "complaint.direct.received": (env) => runComplaintsLifecycle(env),
  "complaint.investigation.completed": (env) => runComplaintsLifecycle(env),
  "complaint.regulator.received": (env) => runComplaintsLifecycle(env),
  "complaint.trend.reported": (env) => runComplaintsLifecycle(env),
  "complaint.received": (env) => runComplaintsLifecycle(env),
  "complaint.logged": (env) => runComplaintsLifecycle(env),
  "complaint.acknowledged": (env) => runComplaintsLifecycle(env),
  "dispute.opened": (env) => runComplaintsLifecycle(env),
  "dispute.provisional_credit_due_at": (env) => runComplaintsLifecycle(env),
  "dispute.investigation.completed": (env) => runComplaintsLifecycle(env),
  "complaint.privacy.received": (env) => runComplaintsLifecycle(env),
  "complaint.trend.review.due": (env) => runComplaintsLifecycle(env),
  "compliance.board.report.due_at": (env) => runComplaintsLifecycle(env),
  "privacy.board.report.due_at": (env) => runComplaintsLifecycle(env),
  "incident.material": (env) => runComplaintsLifecycle(env),
  "risk_breach.detected": (env) => runRiskExceptionsLifecycle(env),
  "risk_breach.triage.due_at": (env) => runRiskExceptionsLifecycle(env),
  "risk_breach.committee_due_at": (env) => runRiskExceptionsLifecycle(env),
  "risk_breach.review.due_at": (env) => runRiskExceptionsLifecycle(env),
  "risk_acceptance.requested": (env) => runRiskExceptionsLifecycle(env),
  "risk_acceptance.decision.due_at": (env) => runRiskExceptionsLifecycle(env),
  "risk_acceptance.expiry_alert_at": (env) => runRiskExceptionsLifecycle(env),
  "risk_acceptance.expiry.warning": (env) => runRiskExceptionsLifecycle(env),
  "risk_acceptance.expired": (env) => runRiskExceptionsLifecycle(env),
  "control.override.invoked": (env) => runRiskExceptionsLifecycle(env),
  "exception.registered": (env) => runRiskExceptionsLifecycle(env),
  "exception.expiring": (env) => runRiskExceptionsLifecycle(env),
  "override.analytics_due": (env) => runRiskExceptionsLifecycle(env),
  "risk.trigger_edd": (env) => runBsaProgramLifecycle(env),
  "monetary_instrument.purchased": (env) => runBsaProgramLifecycle(env),
  "pep.hit": (env) => runBsaProgramLifecycle(env),
  "regulatory.change_required": (env) => runBsaProgramLifecycle(env),
  "regulator.request.received": (env) => runBsaProgramLifecycle(env),
  "pep.designated": (env) => runBsaProgramLifecycle(env),
  "cdd.profile.created": (env) => runBsaProgramLifecycle(env),
  "ofac.annual.report.due": (env) => runBsaProgramLifecycle(env),
  "sar.continuing_timer": (env) => runBsaProgramLifecycle(env),
  "sar.disclosure_request.received": (env) => runBsaProgramLifecycle(env),
  "ctr.exemption.review.due": (env) => runBsaProgramLifecycle(env),
  "application.submitted": (env) => runBsaProgramLifecycle(env),
  "verification.completed": (env) => runBsaProgramLifecycle(env),
  "cmir.reportable.identified": (env) => runBsaProgramLifecycle(env),
  "fbar.account.added": (env) => runBsaProgramLifecycle(env),
  "fbar.filing.timer": (env) => runBsaProgramLifecycle(env),
  "escalation.routed": (env) => runBsaProgramLifecycle(env),
  "escalation.acknowledged": (env) => runBsaProgramLifecycle(env),
  "edd.completed": (env) => runBsaProgramLifecycle(env),
  "filing.fincen_314a": (env) => runBsaProgramLifecycle(env),
  "privacy.annual.notice.due_at": (env) => runPrivacyLifecycle(env),
  "privacy.notice.revised": (env) => runPrivacyLifecycle(env),
  "privacy.notice_copy.requested": (env) => runPrivacyLifecycle(env),
  "privacy.optout.received": (env) => runPrivacyLifecycle(env),
  "privacy.optout.propagation.due_at": (env) => runPrivacyLifecycle(env),
  "privacy.optout.cleared": (env) => runPrivacyLifecycle(env),
  "privacy.nv_optout.received": (env) => runPrivacyLifecycle(env),
  "privacy.state_request.received": (env) => runPrivacyLifecycle(env),
  "web.gpc_signal": (env) => runPrivacyLifecycle(env),
  "privacy.state_request_fulfilled": (env) => runPrivacyLifecycle(env),
  "analytics.dataset.requested": (env) => runPrivacyLifecycle(env),
  "analytics.method.review.due_at": (env) => runPrivacyLifecycle(env),
  "analytics.reid_risk_assessment": (env) => runPrivacyLifecycle(env),
  "web.session.started": (env) => runPrivacyLifecycle(env),
  "web.consent.updated": (env) => runPrivacyLifecycle(env),
  "web.tag_review": (env) => runPrivacyLifecycle(env),
  "web.tag_review.requested": (env) => runPrivacyLifecycle(env),
  "verification.biometric.started": (env) => runPrivacyLifecycle(env),
  "verification.biometric.completed": (env) => runPrivacyLifecycle(env),
  "verification.biometric.purge.due_at": (env) => runPrivacyLifecycle(env),
  "privacy.age_gate.blocked": (env) => runPrivacyLifecycle(env),
  "privacy.minor_data.detected": (env) => runPrivacyLifecycle(env),
  "privacy.minor_data_deleted": (env) => runPrivacyLifecycle(env),
  "furnishing.correction.applied": (env) => runPrivacyLifecycle(env),
  "address.ncoa_mismatch.detected": (env) => runPrivacyLifecycle(env),
  "furnishing.dispute.received": (env) => runPrivacyLifecycle(env),
  "correction.propagated": (env) => runPrivacyLifecycle(env),
  "privacy.notice_template.published": (env) => runPrivacyLifecycle(env),
  "privacy.esign_consent.started": (env) => runPrivacyLifecycle(env),
  "loan.delinquency_day_10": (env) => runCollectionsLifecycle(env),
  "loan.delinquency_day_30": (env) => runCollectionsLifecycle(env),
  "loan.delinquency_day_90": (env) => runCollectionsLifecycle(env),
  "loan.nonaccrual.triggered": (env) => runCollectionsLifecycle(env),
  "loan.charged_off": (env) => runCollectionsLifecycle(env),
  "loan.modification.requested": (env) => runCollectionsLifecycle(env),
  "loan.modification.decided": (env) => runCollectionsLifecycle(env),
  "member.attorney_flag_set": (env) => runCollectionsLifecycle(env),
  "collections.contact.attempted": (env) => runCollectionsLifecycle(env),
  "furnishing.cycle_due_at": (env) => runCollectionsLifecycle(env),
  "overdraft.referral.issued": (env) => runCollectionsLifecycle(env),
  "overdraft.charged_off": (env) => runCollectionsLifecycle(env),
  "collections.policy_version.activated": (env) => runCollectionsLifecycle(env),
  "tdr.determination.recorded": (env) => runCollectionsLifecycle(env),
  "loan.classification.assigned": (env) => runCollectionsLifecycle(env),
  "loan.delinquency_day_60": (env) => runCollectionsLifecycle(env),
  "loan.chargeoff_due_closed_end": (env) => runCollectionsLifecycle(env),
  "loan.chargeoff_due_open_end": (env) => runCollectionsLifecycle(env),
  "loan.bankruptcy_notice.received": (env) => runCollectionsLifecycle(env),
  "loan.fraud.confirmed": (env) => runCollectionsLifecycle(env),
  "loan.death_loss_estimable": (env) => runCollectionsLifecycle(env),
  "loan.re_writedown": (env) => runCollectionsLifecycle(env),
  "loan.accrual.restored": (env) => runCollectionsLifecycle(env),
  "loan.rating_review.completed": (env) => runCollectionsLifecycle(env),
  "loan.foreclosure.proposed": (env) => runCollectionsLifecycle(env),
  "loan.workout.requested": (env) => runCollectionsLifecycle(env),
  "loan.io_capitalization.proposed": (env) => runCollectionsLifecycle(env),
  "loan.modified_payment_3.received": (env) => runCollectionsLifecycle(env),
  "tdr.quarterly_review.completed": (env) => runCollectionsLifecycle(env),
  "collections.cease_request.received": (env) => runCollectionsLifecycle(env),
  "collections.template.submitted": (env) => runCollectionsLifecycle(env),
  "overdraft.report.reviewed": (env) => runCollectionsLifecycle(env),
  "overdraft.fee.logged": (env) => runCollectionsLifecycle(env),
  "overdraft.waiver.requested": (env) => runCollectionsLifecycle(env),
  "overdraft.recurring_pattern.detected": (env) => runCollectionsLifecycle(env),
  "collections.board_report.issued": (env) => runCollectionsLifecycle(env),
  "collections.policy_review.completed": (env) => runCollectionsLifecycle(env),
  "collections.policy_breach.logged": (env) => runCollectionsLifecycle(env),
  "loan.dpd.updated": (env) => runCollectionsLifecycle(env),
  "collections.courtesy_notice.sent": (env) => runCollectionsLifecycle(env),
  "incident.collections.logged": (env) => runCollectionsLifecycle(env),
  "furnishing.idtheft_dispute.received": (env) => runCollectionsLifecycle(env),
  "disclosure.template.published": (env) => runDepositsMemberLifecycle(env),
  "disclosure.account_opening.delivered": (env) => runDepositsMemberLifecycle(env),
  "disclosure.change_in_terms.sent": (env) => runDepositsMemberLifecycle(env),
  "disclosure.maturity_notice.sent": (env) => runDepositsMemberLifecycle(env),
  "statement.issued": (env) => runDepositsMemberLifecycle(env),
  "interest.accrual_run.completed": (env) => runDepositsMemberLifecycle(env),
  "product.interest_config.updated": (env) => runDepositsMemberLifecycle(env),
  "fee.ytd_total": (env) => runDepositsMemberLifecycle(env),
  "member.eligibility.determined": (env) => runDepositsMemberLifecycle(env),
  "member.eligibility.denied": (env) => runDepositsMemberLifecycle(env),
  "entity.address.changed": (env) => runDepositsMemberLifecycle(env),
  "member.preferences.updated": (env) => runDepositsMemberLifecycle(env),
  "member.restriction_notice.sent": (env) => runDepositsMemberLifecycle(env),
  "record.bulk_export.completed": (env) => runDepositsMemberLifecycle(env),
  "service.first.response.due_at": (env) => runDepositsMemberLifecycle(env),
  "service.first_response.sent": (env) => runDepositsMemberLifecycle(env),
  "service.resolved": (env) => runDepositsMemberLifecycle(env),
  "lo_comp.plan.decided": (env) => runDepositsMemberLifecycle(env),
  "application.options.presented": (env) => runDepositsMemberLifecycle(env),
  "applicant.gmi_responses": (env) => runDepositsMemberLifecycle(env),
  "hmda.gmi.recorded": (env) => runDepositsMemberLifecycle(env),
  "notice.incompleteness.sent": (env) => runDepositsMemberLifecycle(env),
  "aan.queued": (env) => runDepositsMemberLifecycle(env),
  "valuation.rights_disclosure.sent": (env) => runDepositsMemberLifecycle(env),
  "valuation.copy.sent": (env) => runDepositsMemberLifecycle(env),
  "disclosure.error.detected": (env) => runDepositsMemberLifecycle(env),
  "account.maturity.notice.due_at": (env) => runDepositsMemberLifecycle(env),
  "disclosure.change_in_terms_due_at": (env) => runDepositsMemberLifecycle(env),
  "disclosure.classification.logged": (env) => runDepositsMemberLifecycle(env),
  "balance.disclosed": (env) => runDepositsMemberLifecycle(env),
  "member.address_notice": (env) => runDepositsMemberLifecycle(env),
  "member.closure_payout.sent": (env) => runDepositsMemberLifecycle(env),
  "application.option_waiver.decided": (env) => runDepositsMemberLifecycle(env),
  "application.disclosures.presented": (env) => runDepositsMemberLifecycle(env),
  "hmda.lar_row.recorded": (env) => runDepositsMemberLifecycle(env),
  "interest.accrued_balance": (env) => runDepositsMemberLifecycle(env),
  "account.adverse_action.decided": (env) => runDepositsMemberLifecycle(env),
  "account.closure.approved": (env) => runDepositsMemberLifecycle(env),
  "account.created": (env) => runDepositsMemberLifecycle(env),
  "account.lock.applied": (env) => runDepositsMemberLifecycle(env),
  "account.maturity_window.opened": (env) => runDepositsMemberLifecycle(env),
  "analytics.quarter.closed": (env) => runLendingUwLifecycle(env),
  "analytics.threshold.breached": (env) => runDepositsMemberLifecycle(env),
  "application.first_lien.created": (env) => runDepositsMemberLifecycle(env),
  "application.form.rendered": (env) => runDepositsMemberLifecycle(env),
  "application.hmda_covered.created": (env) => runLendingUwLifecycle(env),
  "application.option_selection.started": (env) => runDepositsMemberLifecycle(env),
  "application.option_shortfall.detected": (env) => runDepositsMemberLifecycle(env),
  "balance.inquiry.received": (env) => runDepositsMemberLifecycle(env),
  "card.request_during_address_hold": (env) => runDepositsMemberLifecycle(env),
  "estate.claim.submitted": (env) => runViolationTierLifecycle(env),
  "expulsion.board_report.filed": (env) => runDepositsMemberLifecycle(env),
  "fee.overdraft.posted": (env) => runDepositsMemberLifecycle(env),
  "hmda.submission_window_open": (env) => runLendingUwLifecycle(env),
  "interest.credited": (env) => runDepositsMemberLifecycle(env),
  "lo_comp.plan.submitted": (env) => runDepositsMemberLifecycle(env),
  "member.address_notice.sent": (env) => runDepositsMemberLifecycle(env),
  "member.application.submitted": (env) => runDepositsMemberLifecycle(env),
  "member.death.reported": (env) => runViolationTierLifecycle(env),
  "member.delivery.failed": (env) => runDepositsMemberLifecycle(env),
  "member.eligibility_rule.failed": (env) => runDepositsMemberLifecycle(env),
  "member.expulsion.decided": (env) => runViolationTierLifecycle(env),
  "member.expulsion_hearing.held": (env) => runViolationTierLifecycle(env),
  "member.expulsion_hearing.requested": (env) => runViolationTierLifecycle(env),
  "member.expulsion_notice.sent": (env) => runViolationTierLifecycle(env),
  "member.expulsion_payout.sent": (env) => runViolationTierLifecycle(env),
  "pricing.exception.requested": (env) => runDepositsMemberLifecycle(env),
  "privacy.esign_consent.recorded": (env) => runDepositsMemberLifecycle(env),
  "record.bulk_export.requested": (env) => runDepositsMemberLifecycle(env),
  "redflag.detected": (env) => runDepositsMemberLifecycle(env),
  "service.inquiry.received": (env) => runDepositsMemberLifecycle(env),
  "service.reclassified_as_dispute": (env) => runDepositsMemberLifecycle(env),
  "statement.cycle.closed": (env) => runDepositsMemberLifecycle(env),
  "verification.denied": (env) => runDepositsMemberLifecycle(env),
  "ecommerce.credentials.issued": (env) => runEcommerceLifecycle(env),
  "ecommerce.enrollment.received": (env) => runEcommerceLifecycle(env),
  "ecommerce.enrollment.verified": (env) => runEcommerceLifecycle(env),
  "ecommerce.login.failed": (env) => runEcommerceLifecycle(env),
  "ecommerce.repudiation_claim.received": (env) => runEcommerceLifecycle(env),
  "ecommerce.risk.assessment.due": (env) => runEcommerceLifecycle(env),
  "ecommerce.transaction.initiated": (env) => runEcommerceLifecycle(env),
  "member_credential.expiry.due": (env) => runEcommerceLifecycle(env),
  "member_credential.temp_password.issued": (env) => runEcommerceLifecycle(env),
  "collateral.file.posted": (env) => runLiquidityLifecycle(env),
  "collateral.large_move.detected": (env) => runLiquidityLifecycle(env),
  "ewi.major_event.flagged": (env) => runLiquidityLifecycle(env),
  "ewi.spike.flagged": (env) => runLiquidityLifecycle(env),
  "facility.test.due_at": (env) => runLiquidityLifecycle(env),
  "lar.band.changed": (env) => runLiquidityLifecycle(env),
  "liquidity.eod.posted": (env) => runLiquidityLifecycle(env),
  "liquidity.large_flow.detected": (env) => runLiquidityLifecycle(env),
  "mismatch.breach.dispositioned": (env) => runLiquidityLifecycle(env),
  "report.board_due_at": (env) => runLiquidityLifecycle(env),
  "report.weekly_digest.published": (env) => runLiquidityLifecycle(env),
  "stress.assumption.changed": (env) => runLiquidityLifecycle(env),
  "account_freeze.approved": (env) => runResolutionLifecycle(env),
  "account_freeze.credit.presented": (env) => runResolutionLifecycle(env),
  "account_freeze.legal_conflict.detected": (env) => runResolutionLifecycle(env),
  "account_freeze.release.approved": (env) => runResolutionLifecycle(env),
  "ewi.ceo_summary.sent": (env) => runResolutionLifecycle(env),
  "ewi.sweep.completed": (env) => runResolutionLifecycle(env),
  "ewi.threshold.breached": (env) => runResolutionLifecycle(env),
  "institution_freeze.activated": (env) => runResolutionLifecycle(env),
  "institution_freeze.notice.published": (env) => runResolutionLifecycle(env),
  "institution_freeze.ordered": (env) => runResolutionLifecycle(env),
  "member_portal.access.logged": (env) => runResolutionLifecycle(env),
  "records_package.build.started": (env) => runResolutionLifecycle(env),
  "records_package.completed": (env) => runResolutionLifecycle(env),
  "records_package.snapshot.completed": (env) => runResolutionLifecycle(env),
  "records_package.verification.failed": (env) => runResolutionLifecycle(env),
  "cfp.level.changed": (env) => runBaselLifecycle(env),
  "liquidity.cfp_trigger.breached": (env) => runBaselLifecycle(env),
  "liquidity.concentration.breached": (env) => runBaselLifecycle(env),
  "rwa.schedule.approved": (env) => runBaselLifecycle(env),
  "rwa.schedule_change.proposed": (env) => runBaselLifecycle(env),
  "cap.approved": (env) => runBcpLifecycle(env),
  "cap.retest.verified": (env) => runBcpLifecycle(env),
  "comms.media_inquiry.received": (env) => runBcpLifecycle(env),
  "comms.platform.failed": (env) => runBcpLifecycle(env),
  "pir.drafted": (env) => runBcpLifecycle(env),
  "access.role.requested": (env) => runTailLifecycle(env),
  "affiliate.asset_purchase.proposed": (env) => runTailLifecycle(env),
  "affiliate.covered_transaction.proposed": (env) => runTailLifecycle(env),
  "affiliate.credit_transaction.funded": (env) => runTailLifecycle(env),
  "affiliate.list_review.opened": (env) => runTailLifecycle(env),
  "affiliate.transaction.recorded": (env) => runTailLifecycle(env),
  "asset.changed": (env) => runTailLifecycle(env),
  "eps.client_limit_change.requested": (env) => runTailLifecycle(env),
  "eps.control_review.completed": (env) => runTailLifecycle(env),
  "eps.control_review.opened": (env) => runTailLifecycle(env),
  "eps.deficiency_remediation.opened": (env) => runTailLifecycle(env),
  "eps.deployment.emergency_exception": (env) => runTailLifecycle(env),
  "eps.deployment.scheduled": (env) => runTailLifecycle(env),
  "eps.erm_review.decided": (env) => runTailLifecycle(env),
  "eps.product_risk_analysis.drafted": (env) => runTailLifecycle(env),
  "eps.proposal.submitted": (env) => runTailLifecycle(env),
  "eps.service.activated": (env) => runTailLifecycle(env),
  "eps.test_results.recorded": (env) => runTailLifecycle(env),
  "eps.test_retro.completed": (env) => runTailLifecycle(env),
  "eps.wire_release.requested": (env) => runTailLifecycle(env),
  "gl.eod.closed": (env) => runTailLifecycle(env),
  "gl.period.closed": (env) => runTailLifecycle(env),
  "insider.public_request": (env) => runTailLifecycle(env),
  "recon.item.escalated": (env) => runTailLifecycle(env),
  "recon.item.resolved": (env) => runTailLifecycle(env),
  "redflag.case.disposed": (env) => runTailLifecycle(env),
  "security.quarter.closed": (env) => runTailLifecycle(env),
  "sod.compensating_control.proposed": (env) => runTailLifecycle(env),
  "sod.review.timer": (env) => runTailLifecycle(env),
  "sod.violation.logged": (env) => runTailLifecycle(env),
  "incident.declared": (env) => runIncidentLifecycle(env),
  "incident.detected": (env) => runIncidentLifecycle(env),
  "incident.sev1.detected": (env) => runIncidentLifecycle(env),
  // PR-18 and the incident policy both hang off classification; both run.
  "incident.classified": async (env) => {
    await runIncidentLifecycle(env);
    await runPrivacyLifecycle(env);
  },
  "incident.criminal_suspected": async (env) => {
    await runIncidentLifecycle(env);
    await runPrivacyLifecycle(env);
  },
  "incident.severity.assigned": (env) => runIncidentLifecycle(env),
  "incident.ic.assigned": (env) => runIncidentLifecycle(env),
  "incident.first_hour.completed": (env) => runIncidentLifecycle(env),
  "incident.contained": (env) => runIncidentLifecycle(env),
  "incident.closed": (env) => runIncidentLifecycle(env),
  "incident.signal.received": (env) => runIncidentLifecycle(env),
  "incident.reportability_determination": (env) => runIncidentLifecycle(env),
  "incident.member_impact.confirmed": (env) => runIncidentLifecycle(env),
  "incident.created": (env) => runIncidentLifecycle(env),
  "incident.ncua.notified": (env) => runIncidentLifecycle(env),
  "incident.member_notices.sent": (env) => runIncidentLifecycle(env),
  "transfer.settled": async (env) => {
    await postTransfer(
      R({ source_account_id: "acct_4", destination_account_id: "acct_5", amount_cents: 1_000 }),
      env.db, env.cfg, "d", env.actors.ops,
    );
  },
};

/** Generic work-item firers: anything shaped like a lifecycle. */
export async function fireViaWorkItem(
  code: string, uid: string, env: FireEnv,
): Promise<void> {
  const kind = code.includes("request") || code.endsWith(".requested") || code.endsWith(".proposed")
    ? "request"
    : code.endsWith(".received") || code.endsWith(".presented")
    ? "inbound"
    : code.endsWith(".issued") || code.endsWith(".sent") || code.endsWith(".published")
    ? "notice"
    : "task";
  const res = await postWorkItem(
    R({
      control_uid: uid, kind, title: `drill: ${code}`,
      due_at: "2026-08-01T00:00:00Z",
      ...(kind === "inbound" ? { source_ref: "drill", received_at: "2026-07-01T00:00:00Z" } : {}),
    }),
    env.db, "d", env.actors.ops,
  );
  const b = await res.clone().json().catch(() => ({}));
  if (b?.id) {
    await postWorkItemClose(
      R({ outcome: "completed", rationale: "drill" }), b.id, env.db, "d", env.actors.ops,
    );
  }
  await postWorkItemSweep(R({}), env.db, "d", env.actors.ops);
}

/** Generic threshold firer: anything shaped like a breach. */
export async function fireViaThreshold(code: string, uid: string, env: FireEnv): Promise<void> {
  // deterministic id: the table is UNIQUE on (control_uid, metric, scope), so
  // a run-random id collides with the last run's row on the live tier —
  // converging on the same id makes the upsert idempotent instead
  const id = `th_${uid}_${code}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60);
  const res = await putThreshold(
    R({ control_uid: uid, metric: code, subject_scope: "institution", limit_value: 10 }),
    id, env.db, "d", env.actors.ops,
  );
  // the writer may ADOPT an existing row for the same (control, metric,
  // scope) — observe against the id it actually settled on
  const settled = (await res.clone().json().catch(() => ({}))) as { id?: string };
  await postObservation(R({ value: 999 }), String(settled.id ?? id), env.db, "d", env.actors.ops);
}

/** Generic attestation firer: anything shaped like a record/log/attest. */
export async function fireViaAttestation(code: string, uid: string, env: FireEnv): Promise<void> {
  await postAttestation(
    R({ control_uid: uid, statement: `drill: ${code}`, evidence_ref: code }),
    env.db, "d", env.actors.ops,
  );
}

export { TIMER_RE };
