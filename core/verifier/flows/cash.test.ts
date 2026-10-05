// Flows: currency at the teller window, and the Currency Transaction Report it
// can owe (BSA-08, cash.ts; crosswalk control CG-CASH-01).
//
// Ports compliance_e2e.sh §37 and the stubbed cash.test.ts. A CTR is owed when
// one PERSON's currency in one direction aggregates over $10,000 in a business
// day, across every account they hold. The CTR path writes no control_result:
// the old CG-CTR-01 id was renamed CG-LGTXN-01 (OQ-01) and now names the
// ELECTRONIC monitor. The cash evidence is the ctr_filing row, the
// ctr.threshold.reached / ctr.filing.timer events, a ctr_currency_threshold
// bsa_alert and a 5-year retention record.
//
// Actors: a credit-union teller (cu_admin) records currency; operations reads
// the day's aggregation and runs the overdue sweep; a BSA officer files the CTR.
// Partners (fintechs) cannot see cash at all.
//
// Business dates: per-person aggregation is isolated by fresh people, so the
// main flow uses today. The "complete day", "nobody filed" and "unattributable
// residue" flows each use a random business date far in the past. No other
// run writes there, so the day-level totals can be asserted exactly, and a
// past date makes the 15-day deadline already blown without editing the
// database.
import { actor, api, assert, assertEq, core, flow, personaName } from "./helpers.ts";

const THRESHOLD = 1_000_000; // $10,000.00 — the line is ABOVE this, not at it

const today = () => new Date().toISOString().slice(0, 10);

/** A random business date in 1960–1999; nothing else writes cash there. */
function isolatedDate(): string {
  const start = Date.UTC(1960, 0, 1);
  const span = Date.UTC(1999, 11, 31) - start;
  return new Date(start + Math.floor(Math.random() * span)).toISOString().slice(0, 10);
}

/** business date + 15 calendar days, as YYYY-MM-DD */
function dueDate(businessDate: string): string {
  const d = new Date(`${businessDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 15);
  return d.toISOString().slice(0, 10);
}

const body = (r: { body: unknown }) => JSON.stringify(r.body).slice(0, 300);

async function person(): Promise<string> {
  const r = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1979-06-02",
    address: "12 Teller Ln, Springfield, IL 62701",
  });
  assertEq(r.status, 201, `create person (${body(r)})`);
  return String(r.body.id);
}

async function checking(entityId: string): Promise<string> {
  const r = await api("POST", "/accounts", { entity_id: entityId, account_type: "checking" });
  assertEq(r.status, 201, `open account (${body(r)})`);
  return String(r.body.id);
}

type Cash = {
  direction: "cash_in" | "cash_out";
  amount_cents: number;
  business_date: string;
  account_id?: string;
  entity_id?: string;
};

function teller(key: string) {
  return (c: Cash) => api("POST", "/cash/transactions", { ...c, teller_ref: "flow-teller-07", branch_ref: "br_main" }, { key });
}

async function ctrRows(entityId: string, businessDate: string) {
  const r = await core().from("ctr_filing")
    .select("id, entity_id, business_date, cash_in_total, cash_out_total, threshold_crossed_at, filing_due_at, filed_at, filed_by, fincen_ref, provenance")
    .eq("entity_id", entityId).eq("business_date", businessDate);
  assert(!r.error, `ctr_filing read: ${r.error?.message}`);
  return r.data ?? [];
}

async function events(code: string, resourceId: string) {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("code", code).eq("resource_id", resourceId);
  assert(!r.error, `event read: ${r.error?.message}`);
  return r.data ?? [];
}

// ---------------------------------------------------------------------------

flow("cash: one person's currency aggregates across accounts → CTR owed → BSA officer files it", async (t) => {
  const day = today();
  const tellerKey = await actor("cu_admin");
  const officerKey = await actor("cu_admin", ["bsa_officer"]);
  const record = teller(tellerKey);

  let marcus = "", marcusChk = "", marcusSav = "";
  let ana = "", anaAcct = "", ben = "", benAcct = "";
  const ctrId = () => `ctr_${marcus}_${day}`;

  await t.step("onboard three members; Marcus holds two accounts", async () => {
    marcus = await person();
    marcusChk = await checking(marcus);
    marcusSav = await checking(marcus);
    ana = await person();
    anaAcct = await checking(ana);
    ben = await person();
    benAcct = await checking(ben);
  });

  await t.step("$6,000 cash in to Marcus's first account: attributed to him, no CTR yet", async () => {
    const r = await record({ direction: "cash_in", amount_cents: 600_000, business_date: day, account_id: marcusChk });
    assertEq(r.status, 201, `cash in (${body(r)})`);
    assertEq(r.body.attributable, true, "attributable");
    assertEq(r.body.entity_id, marcus, "the person is inherited from the account");
    assertEq(r.body.ctr, null, "under $10k: no CTR");
    assertEq(r.body.day_totals?.cash_in, 600_000, "day total so far");
  });

  await t.step("$6,000 more into his OTHER account crosses $10k for the person → CTR opened", async () => {
    const r = await record({ direction: "cash_in", amount_cents: 600_000, business_date: day, account_id: marcusSav });
    assertEq(r.status, 201, `cash in (${body(r)})`);
    assertEq(r.body.day_totals?.cash_in, 1_200_000, "aggregated across both accounts");
    assert(r.body.ctr, `a CTR is owed (got ${body(r)})`);
    assertEq(r.body.ctr.id, ctrId(), "CTR id is per person per business day");
    assertEq(r.body.ctr.cash_in_total, 1_200_000, "CTR cash-in total");
    assertEq(r.body.ctr.filed, false, "not filed yet");
    assertEq(String(r.body.ctr.filing_due_at).slice(0, 10), dueDate(day), "15 calendar days from the business date");
  });

  await t.step("evidence: both cash rows, the ctr_filing, BSA-08 trigger + 15-day timer, a BSA alert, the retention clock", async () => {
    const tx = await core().from("cash_transaction").select("id, account_id, entity_id, amount, direction, provenance, teller_ref")
      .eq("entity_id", marcus).eq("business_date", day);
    assert(!tx.error, `cash_transaction read: ${tx.error?.message}`);
    assertEq(tx.data!.length, 2, "two currency rows recorded for Marcus");
    assertEq(new Set(tx.data!.map((x) => x.account_id)).size, 2, "on two different accounts");
    assert(tx.data!.every((x) => x.provenance === "demo"), `test-actor rows labelled demo (${JSON.stringify(tx.data)})`);
    assert(tx.data!.every((x) => x.teller_ref === "flow-teller-07"), "teller reference kept");

    const ctr = await ctrRows(marcus, day);
    assertEq(ctr.length, 1, "exactly one CTR obligation for (Marcus, today)");
    assertEq(ctr[0].id, ctrId(), "ctr_filing id");
    assertEq(Number(ctr[0].cash_in_total), 1_200_000, "ctr_filing cash_in_total");
    assertEq(ctr[0].filed_at, null, "unfiled");
    assertEq(String(ctr[0].filing_due_at).slice(0, 10), dueDate(day), "ctr_filing due date");
    assertEq(ctr[0].provenance, "demo", "ctr_filing provenance");

    const res = `ctr_filing:${ctrId()}`;
    assertEq((await events("ctr.threshold.reached", res)).length, 1, "ctr.threshold.reached emitted once");
    assertEq((await events("ctr.filing.timer", res)).length, 1, "ctr.filing.timer emitted once");

    const alert = await core().from("bsa_alert").select("id, alert_type, status, details")
      .eq("id", `alert_${ctrId()}_ctr_currency_threshold`).maybeSingle();
    assert(!alert.error, `bsa_alert read: ${alert.error?.message}`);
    assertEq(alert.data?.alert_type, "ctr_currency_threshold", "BSA alert raised for the CTR");
    assert(String(alert.data?.details).includes(marcus), "alert names the person");

    const rec = await core().from("record").select("record_class, retention_expires_at")
      .eq("id", `rec_${ctrId()}_ctr`).maybeSingle();
    assert(!rec.error, `record read: ${rec.error?.message}`);
    assertEq(rec.data?.record_class, "ctr", "5-year CTR retention clock started");
  });

  await t.step("the same $6k + $6k split across two DIFFERENT people owes nothing", async () => {
    for (const [who, acct] of [[ana, anaAcct], [ben, benAcct]]) {
      const r = await record({ direction: "cash_in", amount_cents: 600_000, business_date: day, account_id: acct });
      assertEq(r.status, 201, `cash in (${body(r)})`);
      assertEq(r.body.entity_id, who, "attributed to its own owner");
      assertEq(r.body.ctr, null, "$6k for one person is not a CTR");
    }
    assertEq((await ctrRows(ana, day)).length, 0, "no ctr_filing for Ana");
    assertEq((await ctrRows(ben, day)).length, 0, "no ctr_filing for Ben");
  });

  await t.step("cash in and cash out are never summed: Ana's $6k in + $6k out is not $12k", async () => {
    const r = await record({ direction: "cash_out", amount_cents: 600_000, business_date: day, account_id: anaAcct });
    assertEq(r.status, 201, `cash out (${body(r)})`);
    assertEq(r.body.day_totals?.cash_in, 600_000, "cash-in total");
    assertEq(r.body.day_totals?.cash_out, 600_000, "cash-out total");
    assertEq(r.body.ctr, null, "no CTR manufactured");
    assertEq((await ctrRows(ana, day)).length, 0, "still no ctr_filing for Ana");
  });

  await t.step("cash out alone can owe one: Ana withdraws $5,000.01 more → $11,000.01 out", async () => {
    const r = await record({ direction: "cash_out", amount_cents: 500_001, business_date: day, account_id: anaAcct });
    assertEq(r.status, 201, `cash out (${body(r)})`);
    assert(r.body.ctr, `CTR owed on the cash-out side (got ${body(r)})`);
    assertEq(r.body.ctr.cash_out_total, 1_100_001, "CTR cash-out total");
    assertEq(r.body.ctr.cash_in_total, 600_000, "cash-in carried separately");
  });

  await t.step("the line is ABOVE $10,000: Ben at exactly $10,000.00 owes nothing; one cent more does", async () => {
    const at = await record({ direction: "cash_in", amount_cents: THRESHOLD - 600_000, business_date: day, account_id: benAcct });
    assertEq(at.status, 201, `cash in (${body(at)})`);
    assertEq(at.body.day_totals?.cash_in, THRESHOLD, "exactly $10,000.00");
    assertEq(at.body.ctr, null, "AT the threshold is not over it");
    assertEq((await ctrRows(ben, day)).length, 0, "no ctr_filing at exactly $10k");

    const over = await record({ direction: "cash_in", amount_cents: 1, business_date: day, account_id: benAcct });
    assertEq(over.status, 201, `cash in (${body(over)})`);
    assertEq(over.body.ctr?.cash_in_total, THRESHOLD + 1, "one cent over opens the CTR");
  });

  await t.step("a later deposit the same day AMENDS Marcus's CTR, never duplicates it", async () => {
    const r = await record({ direction: "cash_in", amount_cents: 100_000, entity_id: marcus, business_date: day });
    assertEq(r.status, 201, `cash in by entity (${body(r)})`);
    assertEq(r.body.entity_id, marcus, "explicit entity_id attributes directly, no account needed");
    assertEq(r.body.ctr?.id, ctrId(), "same CTR id");
    assertEq(r.body.ctr?.cash_in_total, 1_300_000, "total amended to $13,000");
    const ctr = await ctrRows(marcus, day);
    assertEq(ctr.length, 1, "still one ctr_filing");
    assertEq(Number(ctr[0].cash_in_total), 1_300_000, "row amended");
    assertEq((await events("ctr.threshold.reached", `ctr_filing:${ctrId()}`)).length, 1, "the trigger fired once, not per deposit");
  });

  await t.step("operations reads the day per PERSON: Marcus, Ana and Ben each with the right totals", async () => {
    const r = await api("GET", `/cash/aggregation?business_date=${day}`);
    assertEq(r.status, 200, `aggregation (${body(r)})`);
    const by = new Map<string, { cash_in: number; cash_out: number; transaction_count: number; ctr_required: boolean }>(
      (r.body.people ?? []).map((p: { entity_id: string }) => [p.entity_id, p]),
    );
    assertEq(by.get(marcus)?.cash_in, 1_300_000, "Marcus cash in");
    assertEq(by.get(marcus)?.transaction_count, 3, "Marcus: 3 transactions, 2 accounts + 1 direct");
    assertEq(by.get(marcus)?.ctr_required, true, "Marcus owes a CTR");
    assertEq(by.get(ana)?.cash_out, 1_100_001, "Ana cash out");
    assertEq(by.get(ana)?.ctr_required, true, "Ana owes a CTR");
    assertEq(by.get(ben)?.cash_in, THRESHOLD + 1, "Ben cash in");
    assert(!(r.body.people ?? []).some((p: { entity_id: unknown }) => !p.entity_id), "no person bucket without an entity");
  });

  await t.step("filing needs evidence of transmission: no FinCEN reference → 400, nothing filed", async () => {
    const r = await api("POST", `/cash/ctr/${ctrId()}/file`, { filed_by: "bsa-officer" }, { key: officerKey });
    assertEq(r.status, 400, `file without ref (${body(r)})`);
    assert((r.body.errors ?? []).some((e: { field: string }) => e.field === "fincen_ref"), `fincen_ref named (${body(r)})`);
    assertEq((await ctrRows(marcus, day))[0].filed_at, null, "still unfiled");

    const missing = await api("POST", `/cash/ctr/ctr_nobody_${day}/file`, { filed_by: "bsa-officer", fincen_ref: "X" }, { key: officerKey });
    assertEq(missing.status, 404, `filing an unknown CTR (${body(missing)})`);
  });

  let filedAt = "";
  await t.step("the BSA officer files with a reference: on time, row and ctr.filed event agree", async () => {
    const r = await api("POST", `/cash/ctr/${ctrId()}/file`, { filed_by: "bsa-officer", fincen_ref: "BSA-FLOW-0001" }, { key: officerKey });
    assertEq(r.status, 200, `file (${body(r)})`);
    assertEq(r.body.filed_late, false, "filed inside the 15 days");
    assertEq(r.body.entity_id, marcus, "filing names the person");
    filedAt = String(r.body.filed_at);

    const row = (await ctrRows(marcus, day))[0];
    assert(row.filed_at, "ctr_filing.filed_at set");
    assertEq(row.fincen_ref, "BSA-FLOW-0001", "reference stored");
    assertEq(row.filed_by, "bsa-officer", "filer stored");
    const ev = await events("ctr.filed", `ctr_filing:${ctrId()}`);
    assertEq(ev.length, 1, "ctr.filed emitted");
    assertEq(ev[0].payload?.late, false, "event says on time");
    assertEq(ev[0].payload?.fincen_ref, "BSA-FLOW-0001", "event carries the reference");
  });

  await t.step("re-filing replays: same filed_at, no second ctr.filed", async () => {
    const r = await api("POST", `/cash/ctr/${ctrId()}/file`, { filed_by: "someone-else", fincen_ref: "BSA-FLOW-0002" }, { key: officerKey });
    assertEq(r.status, 200, `re-file (${body(r)})`);
    assertEq(r.headers.get("Idempotent-Replayed"), "true", "replay header");
    assertEq(new Date(String(r.body.filed_at)).getTime(), new Date(filedAt).getTime(), "original filed_at");
    const row = (await ctrRows(marcus, day))[0];
    assertEq(row.fincen_ref, "BSA-FLOW-0001", "reference not overwritten");
    assertEq((await events("ctr.filed", `ctr_filing:${ctrId()}`)).length, 1, "one ctr.filed only");
  });
});

// ---------------------------------------------------------------------------

flow("cash: currency nobody can be attributed to is recorded, flagged, and leaves the day INCOMPLETE", async (t) => {
  const day = isolatedDate();
  const record = teller(await actor("cu_admin"));
  let legacy = "";
  const unattributed: string[] = [];
  let carla = "";

  await t.step("a legacy account with no owner exists (pre-OQ-12 history; new accounts must name one)", async () => {
    const r = await core().from("account").select("id").is("entity_id", null).limit(1);
    assert(!r.error, `account read: ${r.error?.message}`);
    assert((r.data ?? []).length === 1, "a NULL-owner legacy account to deposit against");
    legacy = String(r.data![0].id);

    const refused = await api("POST", "/accounts", { account_type: "checking" });
    assertEq(refused.status, 400, `an ownerless account can no longer be opened (${body(refused)})`);
  });

  await t.step("$15,000 cash in to it is RECORDED, said to be unattributable, and claims no CTR determination", async () => {
    const r = await record({ direction: "cash_in", amount_cents: 1_500_000, business_date: day, account_id: legacy });
    assertEq(r.status, 201, `cash in (${body(r)})`);
    assertEq(r.body.attributable, false, "attributable=false");
    assertEq(r.body.entity_id, null, "no fabricated owner");
    assertEq(r.body.ctr, null, "no CTR determination");
    assert(String(r.body.warning).includes("UNATTRIBUTABLE"), `warning in the response (${body(r)})`);
    unattributed.push(String(r.body.id));
  });

  await t.step("evidence: the row exists with a NULL entity, and an unattributable_cash BSA alert names it", async () => {
    const tx = await core().from("cash_transaction").select("entity_id, amount, account_id, provenance")
      .eq("id", unattributed[0]).single();
    assert(!tx.error, `cash_transaction read: ${tx.error?.message}`);
    assertEq(tx.data!.entity_id, null, "entity_id NULL — not dropped, not given a fake owner");
    assertEq(Number(tx.data!.amount), 1_500_000, "amount");
    assertEq(tx.data!.account_id, legacy, "on the legacy account");

    const a = await core().from("bsa_alert").select("alert_type, status, details")
      .eq("id", `alert_${unattributed[0]}_unattributable_cash`).maybeSingle();
    assert(!a.error, `bsa_alert read: ${a.error?.message}`);
    assertEq(a.data?.alert_type, "unattributable_cash", "a finding, not a log line");
    assertEq(a.data?.status, "open", "open for triage");
    assert(String(a.data?.details).includes(unattributed[0]), "alert names the transaction");

    const f = await core().from("ctr_filing").select("id").eq("business_date", day);
    assertEq((f.data ?? []).length, 0, "no CTR row invented for unattributable currency");
  });

  await t.step("three more $9k deposits are NOT each bucketed as their own sub-threshold person", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await record({ direction: "cash_in", amount_cents: 900_000, business_date: day, account_id: legacy });
      assertEq(r.status, 201, `cash in (${body(r)})`);
      assertEq(r.body.attributable, false, "unattributable");
      unattributed.push(String(r.body.id));
    }
  });

  await t.step("a known member's $4k the same day still aggregates normally", async () => {
    carla = await person();
    const acct = await checking(carla);
    const r = await record({ direction: "cash_in", amount_cents: 400_000, business_date: day, account_id: acct });
    assertEq(r.status, 201, `cash in (${body(r)})`);
    assertEq(r.body.ctr, null, "no CTR");
  });

  await t.step("aggregation: day INCOMPLETE, residue surfaced, per-person totals labelled a lower bound", async () => {
    const r = await api("GET", `/cash/aggregation?business_date=${day}`);
    assertEq(r.status, 200, `aggregation (${body(r)})`);
    assertEq(r.body.complete, false, "the day is incomplete");
    assertEq(r.body.unattributable?.cash_in, 1_500_000 + 3 * 900_000, "all $42k of residue counted, none dropped");
    assertEq(r.body.unattributable?.transaction_count, 4, "four unattributable transactions");
    assertEq(
      [...(r.body.unattributable?.transaction_ids ?? [])].sort().join(","),
      [...unattributed].sort().join(","), "the residue lists exactly our transactions",
    );
    assert(String(r.body.warning ?? "").includes("lower bound"), `lower-bound warning (${body(r)})`);
    assertEq((r.body.people ?? []).length, 1, "only Carla is a person — no synthetic identities for the residue");
    assertEq(r.body.people[0].entity_id, carla, "Carla");
    assertEq(r.body.people[0].cash_in, 400_000, "Carla's total");
  });

  await t.step("the CTR sweep reports unattributable currency as a standing gap", async () => {
    const r = await api("POST", "/cash/ctr/sweep", {});
    assertEq(r.status, 200, `sweep (${body(r)})`);
    assert(Number(r.body.unattributable_transactions) > 0, `unattributable_transactions > 0 (${body(r)})`);
    assert(Number(r.body.unattributable_cents) > 0, "unattributable_cents > 0");
  });
});

// ---------------------------------------------------------------------------

flow("cash: a CTR nobody filed is surfaced by the sweep; a late filing is recorded as late", async (t) => {
  const day = isolatedDate();
  const record = teller(await actor("cu_admin"));
  const officerKey = await actor("cu_admin", ["bsa_officer"]);
  let dana = "";
  const ctrId = () => `ctr_${dana}_${day}`;

  await t.step(`a member deposits $11,000 cash on a back-dated business day (${day}) → CTR already past due`, async () => {
    dana = await person();
    const acct = await checking(dana);
    const r = await record({ direction: "cash_in", amount_cents: 1_100_000, business_date: day, account_id: acct });
    assertEq(r.status, 201, `cash in (${body(r)})`);
    assertEq(r.body.ctr?.id, ctrId(), "CTR opened");
    assertEq(String(r.body.ctr?.filing_due_at).slice(0, 10), dueDate(day), "due 15 days after the business day");
  });

  await t.step("a fully attributed day reports COMPLETE with no warning", async () => {
    const r = await api("GET", `/cash/aggregation?business_date=${day}`);
    assertEq(r.status, 200, `aggregation (${body(r)})`);
    assertEq(r.body.complete, true, "complete");
    assertEq(r.body.warning, undefined, "no lower-bound warning");
    assertEq(r.body.unattributable?.transaction_count, 0, "no residue");
    assertEq((r.body.people ?? []).length, 1, "one person");
    assertEq(r.body.people[0].entity_id, dana, "Dana");
    assertEq(r.body.people[0].ctr_required, true, "Dana owes a CTR");
  });

  await t.step("the sweep surfaces the owed-and-unfiled CTR as ctr.filing.overdue", async () => {
    const r = await api("POST", "/cash/ctr/sweep", {});
    assertEq(r.status, 200, `sweep (${body(r)})`);
    assert(
      (r.body.overdue_filings ?? []).some((o: { id: string }) => o.id === ctrId()),
      `our CTR is in overdue_filings (${body(r)})`,
    );
    const ev = await events("ctr.filing.overdue", `ctr_filing:${ctrId()}`);
    assertEq(ev.length, 1, "overdue event written");
    assertEq(ev[0].id, `evt_${ctrId()}_overdue`, "deterministic breach event id");
  });

  await t.step("a second sweep does not pile up a second breach event", async () => {
    const r = await api("POST", "/cash/ctr/sweep", {});
    assertEq(r.status, 200, `sweep (${body(r)})`);
    assertEq((await events("ctr.filing.overdue", `ctr_filing:${ctrId()}`)).length, 1, "still one overdue event");
  });

  await t.step("the officer files it late: accepted, and the lateness is recorded, not suppressed", async () => {
    const r = await api("POST", `/cash/ctr/${ctrId()}/file`, { filed_by: "bsa-officer", fincen_ref: "BSA-FLOW-LATE" }, { key: officerKey });
    assertEq(r.status, 200, `late file (${body(r)})`);
    assertEq(r.body.filed_late, true, "filed_late");
    const ev = await events("ctr.filed", `ctr_filing:${ctrId()}`);
    assertEq(ev.length, 1, "ctr.filed emitted");
    assertEq(ev[0].payload?.late, true, "event records the lateness");
  });

  await t.step("once filed, the sweep no longer lists it", async () => {
    const r = await api("POST", "/cash/ctr/sweep", {});
    assertEq(r.status, 200, `sweep (${body(r)})`);
    assert(!(r.body.overdue_filings ?? []).some((o: { id: string }) => o.id === ctrId()), "filed CTR is not overdue");
  });
});

// ---------------------------------------------------------------------------

flow("cash: the teller's input is checked, and a partner cannot reach cash at all", async (t) => {
  const day = today();
  const record = teller(await actor("cu_admin"));
  let erin = "", acct = "";

  await t.step("onboard a member", async () => {
    erin = await person();
    acct = await checking(erin);
  });

  const rowsForAccount = async () => {
    const r = await core().from("cash_transaction").select("id").eq("account_id", acct);
    assert(!r.error, `cash_transaction read: ${r.error?.message}`);
    return (r.data ?? []).length;
  };

  await t.step("business_date is required and must be a date, not a timestamp", async () => {
    for (const bad of [undefined, "2026-07-19T10:00:00Z", "19/07/2026", ""]) {
      const r = await record({ direction: "cash_in", amount_cents: 10_000, account_id: acct, business_date: bad as string });
      assertEq(r.status, 400, `business_date=${bad} (${body(r)})`);
      assert((r.body.errors ?? []).some((e: { field: string }) => e.field === "business_date"), "business_date named");
    }
    assertEq(await rowsForAccount(), 0, "nothing recorded");
  });

  await t.step("a direction other than cash_in/cash_out, or a non-positive amount, is refused", async () => {
    const dir = await record({ direction: "deposit" as "cash_in", amount_cents: 10_000, account_id: acct, business_date: day });
    assertEq(dir.status, 400, `bad direction (${body(dir)})`);
    for (const amt of [0, -500, 12.5]) {
      const r = await record({ direction: "cash_in", amount_cents: amt, account_id: acct, business_date: day });
      assertEq(r.status, 400, `amount ${amt} (${body(r)})`);
    }
    assertEq(await rowsForAccount(), 0, "nothing recorded");
  });

  await t.step("currency with neither an account nor a person is refused", async () => {
    const r = await record({ direction: "cash_in", amount_cents: 10_000, business_date: day });
    assertEq(r.status, 400, `no account/entity (${body(r)})`);
    assert((r.body.errors ?? []).some((e: { field: string }) => e.field === "account_id"), "account_id named");
  });

  await t.step("an unknown account is a 404", async () => {
    const r = await record({ direction: "cash_in", amount_cents: 10_000, business_date: day, account_id: "acct_does_not_exist" });
    assertEq(r.status, 404, `unknown account (${body(r)})`);
  });

  await t.step("an unknown person is refused as a client error, not a 500", async () => {
    // DEFECT: postCashTransaction (cash.ts) has no entity pre-check, so the FK on cash_transaction.entity_id surfaces as a 500
    const r = await record({ direction: "cash_in", amount_cents: 10_000, business_date: day, entity_id: "ent_does_not_exist" });
    assert(r.status === 404 || r.status === 400, `unknown entity should be 404/400, got ${r.status} (${body(r)})`);
  });

  await t.step("aggregation needs a business_date", async () => {
    const r = await api("GET", "/cash/aggregation");
    assertEq(r.status, 400, `aggregation without date (${body(r)})`);
  });

  // The route table's x-actors gate (auth.ts) refuses before the handler runs,
  // so a partner sees 403 insufficient_scope; cash.ts's own 404 is a second
  // wall the router never lets a partner reach.
  await t.step("a partner is refused on every cash route by the actor gate, and writes nothing", async () => {
    const partner = await actor("partner");
    const calls: [string, Promise<{ status: number; body: unknown }>][] = [
      ["record", api("POST", "/cash/transactions", { direction: "cash_in", amount_cents: 10_000, business_date: day, account_id: acct }, { key: partner })],
      ["aggregate", api("GET", `/cash/aggregation?business_date=${day}`, undefined, { key: partner })],
      ["file", api("POST", `/cash/ctr/ctr_${erin}_${day}/file`, { filed_by: "a", fincen_ref: "b" }, { key: partner })],
      ["sweep", api("POST", "/cash/ctr/sweep", {}, { key: partner })],
    ];
    for (const [name, p] of calls) {
      const r = await p;
      assertEq(r.status, 403, `partner ${name} must be refused (${body(r)})`);
      assertEq((r.body as { type?: string }).type, "insufficient_scope", `partner ${name} refusal type`);
    }
    assertEq(await rowsForAccount(), 0, "partner recorded nothing");
  });

  await t.step("the teller's valid deposit lands as demo evidence in core — no simulated cash in core", async () => {
    const r = await record({ direction: "cash_in", amount_cents: 10_000, business_date: day, account_id: acct });
    assertEq(r.status, 201, `cash in (${body(r)})`);
    assertEq(r.body.provenance, "demo", "test actor → demo");
    const row = await core().from("cash_transaction").select("provenance, entity_id").eq("id", r.body.id).single();
    assertEq(row.data?.provenance, "demo", "row provenance");
    assertEq(row.data?.entity_id, erin, "attributed");
    const sim = await core().from("cash_transaction").select("id", { count: "exact", head: true }).eq("provenance", "simulated");
    assertEq(sim.count ?? 0, 0, "no simulated cash in core");
  });
});
