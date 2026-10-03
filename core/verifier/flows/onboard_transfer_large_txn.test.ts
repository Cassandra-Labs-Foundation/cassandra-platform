// Flow: a partner onboards two members, verifies them, opens and funds their
// accounts, then moves more than $10,000 between them. The transfer must settle
// (the control is alert-only) AND leave the BSA evidence behind: a CG-LGTXN-01
// control_result for the transfer and a ctr_threshold bsa_alert naming it.
// (CG-CTR-01 is the CASH control — a book transfer is not currency, so the
// electronic large-transaction control is the one that must fire.)
import { api, assert, assertEq, core, flow, personaName } from "./helpers.ts";

const OPENING = 5_000_000; // $50,000
const CTR_AMOUNT = 1_100_000; // $11,000 — over the $10k currency-transaction line

flow("partner flow: onboard → KYC → open + fund → $11k transfer → large-txn flagged", async (t) => {
  const members: { entity: string; account: string }[] = [];

  for (const who of ["sender", "receiver"]) {
    await t.step(`onboard the ${who}: create the person`, async () => {
      const r = await api("POST", "/entities", {
        type: "person", name: personaName(), date_of_birth: "1988-04-12",
        address: "100 Main St, Springfield, IL 62701", tin: "900-00-0000",
      });
      assertEq(r.status, 201, `create entity (${JSON.stringify(r.body).slice(0, 200)})`);
      assert(r.body.id, "entity has an id");
      members.push({ entity: String(r.body.id), account: "" });
    });

    const m = members[members.length - 1];

    await t.step(`verify the ${who}: KYC approves and OFAC clears`, async () => {
      const r = await api("POST", `/entities/${m.entity}/verifications`, { simulate: "approve" });
      assertEq(r.status, 201, `verification (${JSON.stringify(r.body).slice(0, 200)})`);
      assertEq(r.body.status, "approved", "KYC decision");
      assert(r.body.ofac_result !== "hit", `OFAC result was ${r.body.ofac_result}`);

      const list = await api("GET", `/entities/${m.entity}/verifications`);
      assertEq(list.status, 200, "verification history readable");
      assert(
        list.body.verifications.some((v: { id: string }) => v.id === r.body.id),
        "the new verification appears in the member's history",
      );
    });

    await t.step(`open and fund the ${who}'s checking account`, async () => {
      const r = await api("POST", "/accounts", {
        entity_id: m.entity, account_type: "checking", opening_deposit_cents: OPENING,
      });
      assertEq(r.status, 201, `open account (${JSON.stringify(r.body).slice(0, 200)})`);
      m.account = String(r.body.id);

      const got = await api("GET", `/accounts/${m.account}`);
      assertEq(got.status, 200, "account readable");
      assertEq(got.body.balance, OPENING, "opening deposit landed");
    });
  }

  const [sender, receiver] = members;
  let transferId = "";

  await t.step("send $11,000 sender → receiver: settles, CG-LGTXN-01 reported", async () => {
    const r = await api("POST", "/transfers", {
      source_account_id: sender.account, destination_account_id: receiver.account,
      amount_cents: CTR_AMOUNT, description: "flow: CTR-sized transfer",
    });
    assertEq(r.status, 201, `transfer (${JSON.stringify(r.body).slice(0, 300)})`);
    assertEq(r.body.status, "settled", "alert-only: the transfer still settles");
    transferId = String(r.body.id);
    assert(
      (r.body.control_results ?? []).some((c: { control_id: string }) => c.control_id === "CG-LGTXN-01"),
      `CG-LGTXN-01 on the response (got ${JSON.stringify(r.body.control_results)})`,
    );
  });

  await t.step("the partner sees the money moved", async () => {
    const tr = await api("GET", `/transfers/${transferId}`);
    assertEq(tr.status, 200, "transfer readable");
    assertEq(tr.body.status, "settled", "transfer status on read");
    const [s, d] = await Promise.all([
      api("GET", `/accounts/${sender.account}`),
      api("GET", `/accounts/${receiver.account}`),
    ]);
    assertEq(s.body.balance, OPENING - CTR_AMOUNT, "sender debited");
    assertEq(d.body.balance, OPENING + CTR_AMOUNT, "receiver credited");
  });

  await t.step("the examiner's evidence exists: control_result + bsa_alert", async () => {
    const cr = await core().from("control_result")
      .select("control_id, decision").eq("event", transferId).eq("control_id", "CG-LGTXN-01");
    assert(!cr.error, `control_result read: ${cr.error?.message}`);
    assert((cr.data ?? []).length > 0, "CG-LGTXN-01 control_result persisted for the transfer");

    const alert = await core().from("bsa_alert")
      .select("id, alert_type").eq("alert_type", "ctr_threshold").like("details", `%${transferId}%`);
    assert(!alert.error, `bsa_alert read: ${alert.error?.message}`);
    assert((alert.data ?? []).length > 0, "ctr_threshold bsa_alert raised naming the transfer");
  });
});
