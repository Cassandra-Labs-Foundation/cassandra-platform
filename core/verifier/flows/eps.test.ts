// flow-runner: lane ach-limit — shares instance state only with its lane (see scripts/flow.sh)
// EPS-06 dual control, the ACH half and the approvals queue. The wire half
// (unconditional dual control, self-approval refused, approve/reject) is walked
// in wires.test.ts; this flow covers what only the client limit decides:
// an ACH batch is UNASSESSED until operations configures a limit for the
// partner, and then gets a real determination in both directions.
// Ports the user-observable behaviour of
// core/supabase/functions/api/eps.test.ts (see ledger/eps.md).
//
// SHARED STATE: the client limit is per partner, and this instance has one
// partner. The flow records whatever limit row existed, sets its own values,
// and restores the original in a finally — a missing row is restored as a
// missing row (deleted), never as a configured null or zero. ACH settlement
// does not consult dual_control_status, so concurrent flows are not blocked by
// the temporary limit; only their entries' recorded status differs meanwhile.
import { actor, type Any, api, assert, assertEq, core, flow, personaName } from "./helpers.ts";

const OPENING = 5_000_000; // $50,000
const LIMIT = 100_000; // $1,000 — the temporary per-batch dual-control limit
const COUNTERPARTY = { name: "Acme Vendor", routing_number: "021000021", account_number: "123456789" };

const show = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);

/** the api_token id helpers.actor() derives from the plaintext it returns */
function tokenIdOf(plaintext: string, actorType: string): string {
  return `tok_test_${actorType}_${plaintext.slice("cass_test_".length, "cass_test_".length + 12)}`;
}

async function homePartner(): Promise<string> {
  const inst = await core().from("instance").select("id").limit(1).single();
  const p = await core().from("partner").select("id")
    .eq("status", "active").eq("instance_id", inst.data!.id).order("id").limit(1).single();
  assert(!p.error, `partner lookup: ${p.error?.message}`);
  return String(p.data!.id);
}

async function limitRow(partnerId: string): Promise<Any | null> {
  const r = await core().from("client_limit").select("*").eq("partner_id", partnerId).maybeSingle();
  assert(!r.error, `client_limit read: ${r.error?.message}`);
  return r.data;
}

async function approvalRow(achId: string): Promise<Any | null> {
  const r = await core().from("payment_approval").select("*").eq("id", `appr_ach_transfer_${achId}`).maybeSingle();
  assert(!r.error, `payment_approval read: ${r.error?.message}`);
  return r.data;
}

async function achStatus(achId: string): Promise<string> {
  const r = await core().from("ach_transfer").select("dual_control_status").eq("id", achId).single();
  assert(!r.error, `ach_transfer read: ${r.error?.message}`);
  return String(r.data?.dual_control_status);
}

flow("eps: ACH dual control follows the client limit — unassessed until set, then a real determination both ways", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  const opsId = tokenIdOf(ops, "pynthia_ops");
  const partnerTok = tokenIdOf(partner, "partner");
  let home = "";
  let original: Any | null = null;
  let src = "";
  let unassessedAch = "";
  let requiredAch = "";

  const submit = async (cents: number, label: string) => {
    const r = await api("POST", "/payments/ach",
      { source_account_id: src, amount_cents: cents, counterparty: COUNTERPARTY, window: "next_day" }, { key: partner });
    assertEq(r.status, 201, `${label} (${show(r)})`);
    return String(r.body.id);
  };
  const setLimit = (value: unknown, key: string = ops) =>
    api("PUT", `/eps/client-limits/${home}`, { ach_dual_control_over_cents: value }, { key });

  try {
    await t.step("fixtures: record the partner's current limit; onboard a funded member", async () => {
      home = await homePartner();
      original = await limitRow(home);
      const e = await api("POST", "/entities", {
        type: "person", name: personaName(), date_of_birth: "1979-11-30",
        address: "400 Oak St, Springfield, IL 62701",
      }, { key: partner });
      assertEq(e.status, 201, `create entity (${show(e)})`);
      const a = await api("POST", "/accounts", {
        entity_id: e.body.id, account_type: "checking", opening_deposit_cents: OPENING,
      }, { key: partner });
      assertEq(a.status, 201, `open account (${show(a)})`);
      src = String(a.body.id);
      // start from "unconfigured" whatever a prior run left behind
      if (original && original.ach_dual_control_over_cents !== null) {
        assertEq((await setLimit(null)).status, 200, "clear the limit for the unassessed leg");
      }
    });

    await t.step("with no limit configured an ACH is UNASSESSED — not exempt, and no approval is opened", async () => {
      unassessedAch = await submit(500_000, "unassessed ACH");
      assertEq(await achStatus(unassessedAch), "unassessed", "recorded as unassessed at creation");
      assertEq(await approvalRow(unassessedAch), null, "nothing to approve against: no payment_approval");
      const r = await api("GET", `/ach-transfers/${unassessedAch}`, undefined, { key: partner });
      assertEq(r.status, 200, `read back (${show(r)})`);
      assertEq(r.body.dual_control_status, "unassessed", "the partner sees it was never assessed");
    });

    await t.step("a fintech cannot set its own dual-control threshold", async () => {
      const before = await limitRow(home);
      const r = await setLimit(999_999_999, partner);
      assert(r.status === 403 || r.status === 404, `partner PUT refused (${r.status}: ${show(r)})`);
      assertEq(JSON.stringify(await limitRow(home)), JSON.stringify(before), "limit untouched");
      const q = await api("GET", "/eps/pending-approvals", undefined, { key: partner });
      assert(q.status === 403 || q.status === 404, `partner cannot read the approvals queue (${q.status})`);
    });

    await t.step("a negative or fractional limit is refused by field and writes nothing", async () => {
      const before = await limitRow(home);
      for (const bad of [-1, 1.5, "lots"]) {
        const r = await setLimit(bad);
        assertEq(r.status, 400, `limit ${bad} (${show(r)})`);
        assert((r.body.errors ?? []).some((e: Any) => e.field === "ach_dual_control_over_cents"), `${bad}: names the field`);
      }
      assertEq(JSON.stringify(await limitRow(home)), JSON.stringify(before), "limit untouched");
    });

    await t.step("operations sets a $1,000 limit: stored with who set it, and a durable change event", async () => {
      const r = await setLimit(LIMIT);
      assertEq(r.status, 200, `set limit (${show(r)})`);
      assertEq(r.body.ach_dual_control_over_cents, LIMIT, "echoed");
      assertEq(r.body.set_by, opsId, "setter echoed");
      const row = await limitRow(home);
      assertEq(row?.ach_dual_control_over_cents, LIMIT, "stored");
      assertEq(row?.set_by, opsId, "setter stored");
      const ev = await core().from("event").select("id")
        .eq("code", "eps.client_limit.changed").eq("resource_id", `client_limit:${home}`)
        .eq("payload->>set_by", opsId);
      assert(!ev.error, `event read: ${ev.error?.message}`);
      assert((ev.data ?? []).length >= 1, "eps.client_limit.changed event names the setter");
    });

    await t.step("over the limit is REQUIRED with an approval naming the originator; at or under is NOT required", async () => {
      requiredAch = await submit(LIMIT + 1, "one cent over");
      assertEq(await achStatus(requiredAch), "required", "over the limit");
      const appr = await approvalRow(requiredAch);
      assert(appr, "maker-checker record opened");
      assertEq(appr.created_by, partnerTok, "approval names the originating partner token");
      assertEq(appr.threshold_cents, LIMIT, "the threshold it was judged against");

      for (const [cents, label] of [[LIMIT, "exactly at the limit"], [LIMIT - 1, "under the limit"]] as const) {
        const id = await submit(cents, label);
        assertEq(await achStatus(id), "not_required", `${label} is not over it`);
        assertEq(await approvalRow(id), null, `${label}: no approval opened`);
      }
    });

    await t.step("the approvals queue lists the required ACH as pending and the unconfigured one as unassessed", async () => {
      const r = await api("GET", "/eps/pending-approvals", undefined, { key: ops });
      assertEq(r.status, 200, `queue (${show(r)})`);
      const open = await core().from("payment_approval").select("id", { count: "exact", head: true })
        .is("approved_at", null).is("rejected_at", null);
      assert(r.body.unassessed_count > 0, "unassessed payments exist");
      assert(String(r.body.warning).includes("NOT blocked and NOT determined exempt"),
        "the unassessed state is stated in words, not left to a count");
      // Regression guard (bug found by this flow, fixed 2026-10-03): the counts
      // used to be the length of a 200-item page. They are now the true totals,
      // and the page says when it is not the whole queue.
      assert(Math.abs(r.body.pending_count - (open.count ?? 0)) <= 5,
        `pending_count ${r.body.pending_count} matches the ${open.count} open approvals`);
      const page = r.body.pending as Any[];
      assertEq(r.body.pending_truncated, r.body.pending_count > page.length, "pending_truncated is honest");
      const times = page.map((p) => String(p.created_at));
      assertEq(JSON.stringify(times), JSON.stringify([...times].sort()), "the queue is served oldest first");
      if (r.body.pending_truncated) {
        // the shared demo instance carries hundreds of older open approvals, so
        // this run's ACH sits past the page: it must still be counted
        const mine = await core().from("payment_approval").select("id")
          .eq("resource_id", requiredAch).is("approved_at", null).is("rejected_at", null);
        assertEq((mine.data ?? []).length, 1, "the newly required ACH is an open approval, counted in pending_count");
      } else {
        assert(page.some((p) => p.resource_id === requiredAch), "the newly required ACH is in the pending queue");
      }
      const unassessed = r.body.unassessed as Any[];
      assertEq(r.body.unassessed_truncated, r.body.unassessed_count > unassessed.length, "unassessed_truncated is honest");
      if (!r.body.unassessed_truncated) {
        assert(unassessed.some((u) => u.id === unassessedAch && u.amount === 500_000),
          "the unassessed ACH is listed with its amount");
      }
    });

    await t.step("the originator cannot approve its own ACH; operations can, and both are recorded", async () => {
      const self = await api("POST", `/payments/ach/${requiredAch}/approve`, {}, { key: partner });
      assertEq(self.status, 409, `self-approval (${show(self)})`);
      assertEq(self.body.type, "dual_control_violation", "typed");
      assertEq(await achStatus(requiredAch), "required", "still awaiting a second approver");

      const r = await api("POST", `/payments/ach/${requiredAch}/approve`, { note: "eps flow" }, { key: ops });
      assertEq(r.status, 200, `approve (${show(r)})`);
      assertEq(r.body.originator, partnerTok, "originator on the response");
      assertEq(r.body.approver, opsId, "approver on the response");
      assertEq(await achStatus(requiredAch), "approved", "rail row advanced");
      const appr = await approvalRow(requiredAch);
      assertEq(appr?.approved_by, opsId, "approver stored");
      assert(appr?.approved_at, "approval time stored");
    });

    await t.step("a second decision on a decided approval replays — it does not re-decide", async () => {
      const admin = await actor("cu_admin");
      const r = await api("POST", `/payments/ach/${requiredAch}/approve`, { outcome: "reject" }, { key: admin });
      assertEq(r.status, 200, `re-decide (${show(r)})`);
      assertEq(r.headers.get("Idempotent-Replayed"), "true", "replay header");
      const appr = await approvalRow(requiredAch);
      assertEq(appr?.approved_by, opsId, "the original approver stands");
      assertEq(appr?.rejected_at ?? null, null, "no rejection recorded");
      assertEq(await achStatus(requiredAch), "approved", "still approved");
    });

    await t.step("a limit of ZERO is a real policy: even a $1 batch needs dual control", async () => {
      const r = await setLimit(0);
      assertEq(r.status, 200, `set zero (${show(r)})`);
      assertEq((await limitRow(home))?.ach_dual_control_over_cents, 0, "zero stored as zero");
      const id = await submit(100, "$1 ACH under a zero limit");
      assertEq(await achStatus(id), "required", "zero means every batch");
      assert(await approvalRow(id), "approval opened");
    });

    await t.step("explicit null leaves the limit unconfigured — not zero — and ACH is unassessed again", async () => {
      const r = await setLimit(null);
      assertEq(r.status, 200, `set null (${show(r)})`);
      const row = await limitRow(home);
      assertEq(row?.ach_dual_control_over_cents, null, "stored as null, never collapsed to zero");
      const id = await submit(100, "$1 ACH with the limit cleared");
      assertEq(await achStatus(id), "unassessed", "back to no determination");
      assertEq(await approvalRow(id), null, "no approval opened");
    });
  } finally {
    // restore the partner's policy exactly as found
    if (home) {
      if (original) {
        const { id: _id, created_at: _c, updated_at: _u, ...prior } = original;
        const r = await core().from("client_limit").upsert({ id: original.id, ...prior }, { onConflict: "id" });
        if (r.error) console.error(`restoring client_limit for ${home}: ${r.error.message}`);
      } else {
        const r = await core().from("client_limit").delete().eq("partner_id", home);
        if (r.error) console.error(`removing test client_limit for ${home}: ${r.error.message}`);
      }
    }
  }
});
