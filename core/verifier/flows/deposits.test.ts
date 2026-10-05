// Member-deposit flows: what Pynthia, as the credit union holding the shares,
// owes the member once a fintech has onboarded them.
//
//   * Truth in Savings: membership is determined and then activated, the
//     interest configuration derives its APY, a disclosure is a DELIVERY that
//     snapshots the terms the member saw (and is refused when it would not
//     count as delivery), interest accrues only against a configuration on
//     file, and the statement carries year-to-date fees;
//   * member protection: an address change opens a hold that blocks a card
//     reissue, a restriction lands on the ACCOUNT so the money actually stops,
//     and a bulk export of member records must state its purpose.
//
// Replaces core/supabase/functions/api/deposits_member.test.ts (ledger:
// core/verifier/flows/ledger/deposits_member.md). The /deposits and /members
// routes are internal (x-audience internal, self-gated): a partner token sees
// them as a 404. The CU's staff act here as a cu_admin test actor.
//
// Every write is scoped to run-unique fixtures: interest runs are keyed by a
// run-unique period, statements and disclosures by this run's own account.
import { actor, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

const show = (b: unknown) => JSON.stringify(b).slice(0, 300);

async function event(id: string) {
  const r = await core().from("event").select("code, payload, provenance, resource_id").eq("id", id).maybeSingle();
  assert(!r.error, `event read ${id}: ${r.error?.message}`);
  return r.data as { code: string; payload: Record<string, unknown>; provenance: string; resource_id: string } | null;
}

async function eventsFor(resourceId: string, code: string) {
  const r = await core().from("event").select("id, payload, provenance").eq("resource_id", resourceId).eq("code", code);
  assert(!r.error, `events read ${resourceId}/${code}: ${r.error?.message}`);
  return (r.data ?? []) as { id: string; payload: Record<string, unknown>; provenance: string }[];
}

/** a member onboarded by the fintech: person + funded checking account */
async function onboard(partner: string, openingCents: number): Promise<{ entity: string; account: string }> {
  const e = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1987-03-14",
    address: "12 Elm St, Springfield, IL 62701",
  }, { key: partner });
  assertEq(e.status, 201, `entity (${show(e.body)})`);
  const a = await api("POST", "/accounts", {
    entity_id: e.body.id, account_type: "checking", opening_deposit_cents: openingCents,
  }, { key: partner });
  assertEq(a.status, 201, `account (${show(a.body)})`);
  return { entity: String(e.body.id), account: String(a.body.id) };
}

async function balanceOf(account: string, expected: number): Promise<number> {
  // the mirror lags the ledger briefly; poll
  let last = -1;
  for (let i = 0; i < 10; i++) {
    const r = await api("GET", `/accounts/${account}`);
    last = Number(r.body.balance);
    if (last === expected) return last;
    await new Promise((res) => setTimeout(res, 500));
  }
  return last;
}

const near = (iso: unknown, targetMs: number, slackMs = 10 * 60_000) =>
  typeof iso === "string" && Math.abs(new Date(iso).getTime() - targetMs) < slackMs;
const DAY = 86_400_000;

// =============================================================================
// Truth in Savings, end to end
// =============================================================================

flow("deposits: a member joins, is disclosed to, accrues interest and gets a statement (Truth in Savings)", async (t) => {
  const OPENING = 1_000_000; // $10,000
  const run = uid();
  let partner = "";
  let cu = "";
  let m = { entity: "", account: "" };
  let memberId = "";
  let configId = "";
  let templateId = "";

  await t.step("the fintech onboards a member with a funded share account", async () => {
    partner = await actor("partner");
    cu = await actor("cu_admin");
    m = await onboard(partner, OPENING);
    memberId = `mbr_${m.entity}`;
    assertEq(await balanceOf(m.account, OPENING), OPENING, "opening deposit landed");
  });

  await t.step("the fintech cannot reach the CU's deposit routes: they do not exist for a partner", async () => {
    const version = `v_${run}_partner`;
    const tpl = await api("POST", "/deposits/disclosure-templates",
      { kind: "account_opening", version, content_ref: "r", approved_by: "compliance" }, { key: partner });
    assertEq(tpl.status, 404, `partner template (${show(tpl.body)})`);
    assertEq(tpl.body.type, "not_found", "indistinguishable from a missing route");
    const row = await core().from("disclosure_template").select("id").eq("id", `dtpl_account_opening_${version}`);
    assertEq((row.data ?? []).length, 0, "no template row was written");
    const mem = await api("POST", "/members", { entity_ref: m.entity, eligible: true, eligibility_basis: "x" }, { key: partner });
    assertEq(mem.status, 404, `partner membership (${show(mem.body)})`);
    const bal = await api("POST", `/deposits/accounts/${m.account}/balance-inquiry`, { balance_cents: 1 }, { key: partner });
    assertEq(bal.status, 404, `partner balance inquiry (${show(bal.body)})`);
  });

  await t.step("an eligibility denial with no stated basis is refused and records nothing", async () => {
    const r = await api("POST", "/members", { entity_ref: m.entity, eligible: false }, { key: cu });
    assertEq(r.status, 400, `basis-less denial (${show(r.body)})`);
    assert((r.body.errors ?? []).some((e: { field: string }) => e.field === "denial_reason"), "error names denial_reason");
    const row = await core().from("membership").select("id").eq("id", memberId);
    assertEq((row.data ?? []).length, 0, "no membership row for a refused determination");
  });

  await t.step("MP-01: the CU determines eligibility, then activates — two separate facts", async () => {
    const r = await api("POST", "/members",
      { entity_ref: m.entity, eligible: true, eligibility_basis: "employer group: Springfield Schools" }, { key: cu });
    assertEq(r.status, 201, `membership (${show(r.body)})`);
    assertEq(r.body.data.id, memberId, "membership id derives from the entity");
    const row = await core().from("membership")
      .select("eligible, eligibility_basis, eligibility_determined_at, joined_at, restriction, provenance")
      .eq("id", memberId).single();
    assertEq(row.data?.eligible, true, "eligible");
    assertEq(row.data?.eligibility_basis, "employer group: Springfield Schools", "basis recorded");
    assert(row.data?.eligibility_determined_at && row.data?.joined_at, "determined and joined timestamps");
    assertEq(row.data?.restriction, "none", "unrestricted on joining");
    assertEq(row.data?.provenance, "demo", "test-actor evidence is labelled demo");
    const det = await event(`ev_${memberId}_det`);
    const act = await event(`ev_${memberId}_act`);
    assertEq(det?.code, "member.eligibility.determined", "determination event");
    assertEq(act?.code, "member.activated", "activation event, separate from the determination");
    assertEq(det?.payload.eligible, true, "determination says eligible");
  });

  await t.step("TIS-06: the interest configuration DERIVES its APY — a supplied APY is ignored", async () => {
    const bad = await api("POST", "/deposits/interest-config",
      { product_code: `share_${run}`, rate_bp: 200, compounding: "hourly", balance_method: "daily_balance" }, { key: cu });
    assertEq(bad.status, 400, `unknown compounding (${show(bad.body)})`);

    const r = await api("POST", "/deposits/interest-config", {
      product_code: `share_${run}`, rate_bp: 200, compounding: "daily",
      balance_method: "daily_balance", apy_bp: 999,
    }, { key: cu });
    assertEq(r.status, 201, `config (${show(r.body)})`);
    assertEq(r.body.data.apy_bp, 202, "2% compounded daily is 2.02% APY, not 2%");
    configId = String(r.body.data.id);
    const row = await core().from("product_interest_config")
      .select("rate_bp, compounding, apy_bp, balance_method").eq("id", configId).single();
    assertEq(row.data?.apy_bp, 202, "stored APY is the derived one, not the 999 supplied");
    assertEq(row.data?.rate_bp, 200, "rate stored");
    const ev = await event(`ev_${configId}_cfg`);
    assertEq(ev?.code, "product.interest_config.updated", "config event");
    assertEq(ev?.payload["product.apy_bp"], 202, "event carries the derived APY");

    const annual = await api("POST", "/deposits/interest-config",
      { product_code: `cert_${run}`, rate_bp: 200, compounding: "annual", balance_method: "average_daily_balance" }, { key: cu });
    assertEq(annual.body.data?.apy_bp, 200, "annual compounding: APY equals the rate");
    const q = await api("POST", "/deposits/interest-config",
      { product_code: `mm_${run}`, rate_bp: 500, compounding: "quarterly", balance_method: "daily_balance" }, { key: cu });
    const d = await api("POST", "/deposits/interest-config",
      { product_code: `mmd_${run}`, rate_bp: 500, compounding: "daily", balance_method: "daily_balance" }, { key: cu });
    assert(d.body.data.apy_bp > q.body.data.apy_bp, `daily (${d.body.data.apy_bp}) out-yields quarterly (${q.body.data.apy_bp})`);
  });

  await t.step("TIS-01: compliance publishes the account-opening disclosure template", async () => {
    const version = `v_${run}`;
    const r = await api("POST", "/deposits/disclosure-templates",
      { kind: "account_opening", version, content_ref: `doc://tis/${run}`, approved_by: "compliance officer" }, { key: cu });
    assertEq(r.status, 201, `template (${show(r.body)})`);
    templateId = String(r.body.data.id);
    const row = await core().from("disclosure_template").select("kind, approved_by").eq("id", templateId).single();
    assertEq(row.data?.kind, "account_opening", "kind");
    assertEq(row.data?.approved_by, "compliance officer", "approver recorded");
  });

  const deliveryId = () => `ddel_account_opening_${memberId}_${m.account}`;

  await t.step("E-SIGN: electronic delivery with no captured consent is REFUSED, not recorded", async () => {
    const r = await api("POST", "/deposits/disclosures/deliver", {
      kind: "account_opening", member_ref: memberId, account_ref: m.account,
      channel: "esign", trigger_event: "account.opened", template_id: templateId,
    }, { key: cu });
    assertEq(r.status, 409, `esign without consent (${show(r.body)})`);
    assertEq(r.body.type, "esign_consent_missing", "typed refusal");
    const row = await core().from("disclosure_delivery").select("id").eq("id", deliveryId());
    assertEq((row.data ?? []).length, 0, "no 'we emailed it' row reads as a discharged obligation");
  });

  await t.step("with consent the delivery lands and SNAPSHOTS the terms the member saw", async () => {
    const r = await api("POST", "/deposits/disclosures/deliver", {
      kind: "account_opening", member_ref: memberId, account_ref: m.account,
      channel: "esign", esign_consent_id: `esc_${run}`, trigger_event: "account.opened",
      template_id: templateId, interest_config_id: configId,
      rate_bp: 200, compounding: "daily", account_type: "checking",
    }, { key: cu });
    assertEq(r.status, 201, `delivery (${show(r.body)})`);
    assertEq(r.body.data.id, deliveryId(), "delivery id is per member and account");
    assertEq(r.body.data.delivered, true, "delivered");
    const row = await core().from("disclosure_delivery").select("*").eq("id", deliveryId()).single();
    assertEq(row.data?.template_id, templateId, "which template");
    assertEq(row.data?.channel, "esign", "channel");
    assertEq(row.data?.entity_esign_consent_id, `esc_${run}`, "the consent it relied on");
    assertEq(row.data?.product_interest_rate_bp, 200, "rate snapshotted");
    assertEq(row.data?.product_apy_bp, 202, "APY the member SAW, frozen");
    assertEq(row.data?.account_account_type, "checking", "account type snapshotted");
    assert(row.data?.delivered_at, "delivered_at set");
    assert(near(row.data?.due_at, Date.now()), `account-opening disclosure is due at opening (${row.data?.due_at})`);
    assertEq(row.data?.provenance, "demo", "labelled demo");
    const due = await event(`ev_${deliveryId()}_aodue`);
    const dl = await event(`ev_${deliveryId()}_ao`);
    assertEq(due?.code, "disclosure.account_opening_due_at", "due-at event");
    assertEq(dl?.code, "disclosure.account_opening.delivered", "delivered event");
  });

  await t.step("the snapshot holds when the configuration later moves", async () => {
    const r = await api("POST", "/deposits/interest-config",
      { product_code: `share_${run}`, rate_bp: 300, compounding: "daily", balance_method: "daily_balance" }, { key: cu });
    assertEq(r.status, 201, `new config (${show(r.body)})`);
    const row = await core().from("disclosure_delivery").select("product_apy_bp, product_interest_rate_bp")
      .eq("id", deliveryId()).single();
    assertEq(row.data?.product_interest_rate_bp, 200, "delivery still shows the rate disclosed");
    assertEq(row.data?.product_apy_bp, 202, "and the APY disclosed");
  });

  await t.step("TIS-02/03: a change in terms gets 30 days, is classified, and a detected error is its own finding", async () => {
    const base = {
      kind: "change_in_terms", member_ref: memberId, account_ref: m.account,
      trigger_event: "rate.reduced", adverse: true, error_detected: true,
    };
    const noDetail = await api("POST", "/deposits/disclosures/deliver", base, { key: cu });
    assertEq(noDetail.status, 400, `error flagged without detail (${show(noDetail.body)})`);
    assert((noDetail.body.errors ?? []).some((e: { field: string }) => e.field === "error_detail"), "error names error_detail");

    const r = await api("POST", "/deposits/disclosures/deliver",
      { ...base, error_detail: "notice printed the old APY" }, { key: cu });
    assertEq(r.status, 201, `change in terms (${show(r.body)})`);
    const id = String(r.body.data.id);
    const row = await core().from("disclosure_delivery").select("due_at, error_detected, error_detail").eq("id", id).single();
    assert(near(row.data?.due_at, Date.now() + 30 * DAY), `due 30 days out (${row.data?.due_at})`);
    assertEq(row.data?.error_detected, true, "error flagged on the row");
    assertEq(row.data?.error_detail, "notice printed the old APY", "detail kept");
    const cls = await event(`ev_${id}_class`);
    assertEq(cls?.code, "disclosure.classification.logged", "classification event");
    assertEq(cls?.payload.adverse, true, "classified adverse");
    assertEq(cls?.payload.notice_required, true, "so notice is required");
    const err = await event(`ev_${id}_err`);
    assertEq(err?.code, "disclosure.error.detected", "the error opens its own finding");
    assertEq(err?.payload.detail, "notice printed the old APY", "finding carries the detail");
  });

  await t.step("interest cannot accrue with no configuration on file", async () => {
    const period = `flow-${run}-orphan`;
    const r = await api("POST", "/deposits/interest-runs",
      { period, config_id: `picfg_missing_${run}`, accounts: [{ balance_cents: OPENING }] }, { key: cu });
    assertEq(r.status, 409, `accrual without config (${show(r.body)})`);
    assertEq(r.body.type, "no_interest_config", "typed refusal");
    const row = await core().from("interest_accrual_run").select("id").eq("id", `iaccr_${period}`);
    assertEq((row.data ?? []).length, 0, "no run recorded");
  });

  await t.step("the accrual run carries the configuration it ran against", async () => {
    const period = `flow-${run}`;
    const bal = await api("GET", `/accounts/${m.account}`);
    const r = await api("POST", "/deposits/interest-runs",
      { period, config_id: configId, accounts: [{ account_id: m.account, balance_cents: bal.body.balance }] }, { key: cu });
    assertEq(r.status, 201, `accrual (${show(r.body)})`);
    const expected = Math.floor((OPENING * 200) / 10000 / 12); // one month at 2%
    assertEq(r.body.data.accrued_total_cents, expected, "a month's interest at the configured rate");
    const id = `iaccr_${period}`;
    const row = await core().from("interest_accrual_run")
      .select("config_id, accounts_processed, accrued_total_cents, completed_at, provenance").eq("id", id).single();
    assertEq(row.data?.config_id, configId, "run names its configuration");
    assertEq(row.data?.accounts_processed, 1, "one account");
    assertEq(Number(row.data?.accrued_total_cents), expected, "total");
    assertEq(row.data?.provenance, "demo", "labelled demo");
    const ev = await event(`ev_${id}_run`);
    assertEq(ev?.code, "interest.accrual_run.completed", "completion event");
    assertEq(ev?.payload["product.apy_bp"], 202, "event carries the APY in force");
  });

  await t.step("TIS-08: a balance inquiry discloses available apart from ledger", async () => {
    const bal = await api("GET", `/accounts/${m.account}`);
    const ledger = Number(bal.body.balance);
    const r = await api("POST", `/deposits/accounts/${m.account}/balance-inquiry`,
      { balance_cents: ledger, held_cents: 30_000, reg_e_opt_in: true, channel: "app" }, { key: cu });
    assertEq(r.status, 201, `inquiry (${show(r.body)})`);
    assertEq(r.body.data.available_cents, ledger - 30_000, "available is ledger minus holds");
    const disclosed = await eventsFor(`account:${m.account}`, "balance.disclosed");
    assertEq(disclosed.length, 1, "one disclosure for the inquiry");
    assertEq(disclosed[0].payload.ledger_balance_cents, ledger, "ledger balance disclosed");
    assertEq(disclosed[0].payload.available_balance_cents, ledger - 30_000, "available balance disclosed separately");
    const received = await eventsFor(`account:${m.account}`, "balance.inquiry.received");
    assertEq(received[0]?.payload["entity.reg_e_opt_in"], true, "Reg E opt-in recorded with the inquiry");
  });

  await t.step("the statement carries year-to-date fees, not just the period's", async () => {
    const period = `2026-09-${run}`;
    const missing = await api("POST", "/deposits/statements",
      { account_ref: m.account, period, opening_balance_cents: OPENING }, { key: cu });
    assertEq(missing.status, 400, `statement without a closing balance (${show(missing.body)})`);

    const r = await api("POST", "/deposits/statements", {
      account_ref: m.account, period, opening_balance_cents: OPENING, closing_balance_cents: OPENING + 1_666,
      interest_paid_cents: 1_666, fees_ytd_cents: 4_500, overdraft_fees_ytd_cents: 3_000,
    }, { key: cu });
    assertEq(r.status, 201, `statement (${show(r.body)})`);
    const id = `stmt_${m.account}_${period}`;
    assertEq(r.body.data.id, id, "statement id is per account and period");
    const row = await core().from("statement")
      .select("fees_ytd_cents, overdraft_fees_ytd_cents, interest_paid_cents, closing_balance_cents, issued_at").eq("id", id).single();
    assertEq(Number(row.data?.fees_ytd_cents), 4_500, "YTD fees on the statement");
    assertEq(Number(row.data?.overdraft_fees_ytd_cents), 3_000, "YTD overdraft fees on the statement");
    assertEq(Number(row.data?.interest_paid_cents), 1_666, "interest paid");
    assert(row.data?.issued_at, "issued");
    const ytd = await event(`ev_${id}_ytd`);
    assertEq(ytd?.code, "fee.ytd_total", "1030.11: the YTD total is a disclosure event");
    assertEq(ytd?.payload["fee.overdraft_ytd_total"], 3_000, "overdraft YTD in the event");
    assertEq((await event(`ev_${id}_iss`))?.code, "statement.issued", "statement issued event");
  });
});

// =============================================================================
// Member protection: address hold, restriction, record export
// =============================================================================

flow("deposits: an address hold blocks a card reissue, a restriction stops the money, exports need a purpose", async (t) => {
  const OPENING = 100_000; // $1,000
  let partner = "";
  let cu = "";
  let a = { entity: "", account: "" };
  let b = { entity: "", account: "" };
  const mbr = (e: string) => `mbr_${e}`;

  await t.step("the fintech onboards two members; the CU admits both", async () => {
    partner = await actor("partner");
    cu = await actor("cu_admin");
    a = await onboard(partner, OPENING);
    b = await onboard(partner, OPENING);
    for (const m of [a, b]) {
      const r = await api("POST", "/members", { entity_ref: m.entity, eligible: true, eligibility_basis: "community charter" }, { key: cu });
      assertEq(r.status, 201, `membership (${show(r.body)})`);
    }
    assertEq(await balanceOf(a.account, OPENING), OPENING, "A funded");
    assertEq(await balanceOf(b.account, OPENING), OPENING, "B funded");
  });

  await t.step("MP-02: an address change opens a 30-day hold and notifies the OLD address too", async () => {
    const r = await api("POST", `/members/${mbr(a.entity)}/address`, {
      old_address: { line1: "12 Elm St", city: "Springfield" },
      new_address: { line1: "2 New Ave", city: "Shelbyville" },
    }, { key: cu });
    assertEq(r.status, 201, `address change (${show(r.body)})`);
    const id = String(r.body.data.id);
    const row = await core().from("member_address_change")
      .select("member_ref, hold_expires_at, notice_sent_to_old_at, notice_sent_to_new_at").eq("id", id).single();
    assertEq(row.data?.member_ref, mbr(a.entity), "hold is on this member");
    assert(near(row.data?.hold_expires_at, Date.now() + 30 * DAY), `hold runs 30 days (${row.data?.hold_expires_at})`);
    assert(row.data?.notice_sent_to_old_at, "notice went to the OLD address");
    assert(row.data?.notice_sent_to_new_at, "and to the new one");
    const notice = await event(`ev_${id}_notice`);
    assertEq(notice?.payload.sent_to_old, true, "notice event records the old-address leg");
  });

  await t.step("MP-02: a card reissue inside the hold is recorded AND blocked", async () => {
    const r = await api("POST", `/members/${mbr(a.entity)}/card-reissue`, { ship_to_address_id: "addr_new" }, { key: cu });
    assertEq(r.status, 201, `reissue (${show(r.body)})`);
    assertEq(r.body.data.blocked, true, "blocked");
    const card = await core().from("card").select("status, address_hold_blocked").eq("id", r.body.data.id).single();
    assertEq(card.data?.status, "blocked", "card row is blocked");
    assertEq(card.data?.address_hold_blocked, true, "and says why");
    const ev = await event(`ev_${r.body.data.id}_req`);
    assertEq(ev?.code, "card.request_during_address_hold", "visible to the red-flags review");
    assertEq(ev?.payload.on_hold, true, "event records the open hold");
  });

  await t.step("MP-02: the same reissue for a member with no open hold proceeds", async () => {
    const r = await api("POST", `/members/${mbr(b.entity)}/card-reissue`, {}, { key: cu });
    assertEq(r.status, 201, `reissue (${show(r.body)})`);
    assertEq(r.body.data.blocked, false, "not blocked");
    const card = await core().from("card").select("status, address_hold_blocked").eq("id", r.body.data.id).single();
    assertEq(card.data?.status, "active", "card active");
    assertEq(card.data?.address_hold_blocked, false, "no hold flag");
  });

  await t.step("MP-05: a restriction needs a known kind and a reason", async () => {
    const r = await api("POST", `/members/${mbr(a.entity)}/restrict`,
      { restriction: "suspended", reason: "x", account_ref: a.account }, { key: cu });
    assertEq(r.status, 400, `unknown restriction (${show(r.body)})`);
    const acct = await core().from("account").select("lock_type").eq("id", a.account).single();
    assertEq(acct.data?.lock_type, "none", "account untouched");
  });

  await t.step("MP-05: a freeze lands on the ACCOUNT, not only the membership", async () => {
    const r = await api("POST", `/members/${mbr(a.entity)}/restrict`, {
      restriction: "frozen", reason: "suspected account takeover", account_ref: a.account,
      contact: { email: "member@example.test" }, amounts_owed_cents: 100,
    }, { key: cu });
    assertEq(r.status, 200, `restrict (${show(r.body)})`);
    const acct = await core().from("account").select("restriction, lock_type").eq("id", a.account).single();
    assertEq(acct.data?.restriction, "frozen", "account restriction");
    assertEq(acct.data?.lock_type, "admin", "account locked (schema vocabulary)");
    const mem = await core().from("membership").select("restriction, restriction_reason, account_ref").eq("id", mbr(a.entity)).single();
    assertEq(mem.data?.restriction, "frozen", "membership restriction");
    assertEq(mem.data?.restriction_reason, "suspected account takeover", "reason kept");
    assertEq(mem.data?.account_ref, a.account, "membership names the account");
    assertEq((await event(`ev_${mbr(a.entity)}_restr`))?.code, "member.restriction_notice.sent", "member notified");
  });

  await t.step("and the money actually stops: a transfer out of the frozen account is refused", async () => {
    const r = await api("POST", "/transfers", {
      source_account_id: a.account, destination_account_id: b.account, amount_cents: 5_000,
      description: "flow: from a frozen account",
    }, { key: partner });
    assertEq(r.status, 422, `transfer from frozen (${show(r.body)})`);
    assertEq(r.body.type, "account_locked", "the lock gate refuses by name");
    const settled = await core().from("transfer").select("id").eq("source_account_id", a.account).eq("status", "settled");
    assertEq((settled.data ?? []).length, 0, "no settled transfer out of the frozen account");
    assertEq(await balanceOf(a.account, OPENING), OPENING, "A untouched");
    assertEq(await balanceOf(b.account, OPENING), OPENING, "B untouched");
  });

  await t.step("MP-08: a bulk member-record export with no stated purpose is refused", async () => {
    const r = await api("POST", `/members/${mbr(b.entity)}/records/export`, { record_count: 5000 }, { key: cu });
    assertEq(r.status, 400, `purposeless export (${show(r.body)})`);
    assert((r.body.errors ?? []).some((e: { field: string }) => e.field === "purpose"), "error names purpose");
    const ev = await eventsFor(`membership:${mbr(b.entity)}`, "record.bulk_export.completed");
    assertEq(ev.length, 0, "no export recorded as completed");
  });

  await t.step("MP-08: with a purpose the export completes and names who asked", async () => {
    const r = await api("POST", `/members/${mbr(b.entity)}/records/export`,
      { record_count: 12, purpose: "member data-access request" }, { key: cu });
    assertEq(r.status, 201, `export (${show(r.body)})`);
    const ev = await eventsFor(`membership:${mbr(b.entity)}`, "record.bulk_export.completed");
    assertEq(ev.length, 1, "one export event");
    assertEq(ev[0].payload.purpose, "member data-access request", "purpose recorded");
    assert(String(ev[0].payload.requested_by).startsWith("tok_test_cu_admin_"), `requester is the CU actor (${ev[0].payload.requested_by})`);
    assertEq(ev[0].provenance, "demo", "labelled demo");
  });
});
