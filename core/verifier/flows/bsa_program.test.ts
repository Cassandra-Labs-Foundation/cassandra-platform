// BSA programme flows: the compliance work the institution's own staff do
// outside the alert -> case -> SAR chain and cash CTRs — CIP, OFAC screening
// and hold release, PEP and EDD, 314(a), monetary-instrument logs, the Travel
// Rule, FBAR, regulatory change, escalation, CMIR, SAR confidentiality and the
// CTR exemption review. Every flow is a journey a real person performs, acting
// through a minted staff or partner token, and every compliance claim is
// checked on the row or event an examiner would read.
//
// The OFAC/PEP screens are the OQ-02 stub (a name containing "SDN" / "PEP"
// hits; there is no list), so `list_version` is null everywhere. These flows
// prove the MECHANISM, as the handler header says. The partner-side KYC/OFAC
// floor (POST /entities/{id}/verifications) is onboarding.test.ts's; nothing
// here repeats it.
//
// Ported from core/supabase/functions/api/bsa_program.test.ts (see
// ledger/bsa_program.md).
import { actor, type Any, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

// --------------------------------------------------------------- local helpers

const show = (b: unknown) => JSON.stringify(b).slice(0, 300);
const DAY = 86_400_000;

type Ev = { code: string; payload: Record<string, Any>; provenance: string };

/** events recorded for one resource (`<type>:<id>`), oldest first */
async function eventsFor(resource: string): Promise<Ev[]> {
  const r = await core().from("event").select("code, payload, provenance, created_at")
    .eq("resource_id", resource).order("created_at", { ascending: true });
  assert(!r.error, `event read: ${r.error?.message}`);
  return (r.data ?? []) as Ev[];
}
async function codesFor(resource: string): Promise<string[]> {
  return (await eventsFor(resource)).map((e) => e.code);
}
async function rowById(table: string, id: string): Promise<Any> {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data;
}
/** |b - a| is `days` days, within a minute */
function spans(a: string, b: string, days: number, msg: string): void {
  const d = new Date(b).getTime() - new Date(a).getTime();
  assert(Math.abs(d - days * DAY) < 60_000, `${msg}: expected ${days}d, got ${(d / DAY).toFixed(3)}d`);
}

/** a member the partner onboards: a person, plus an optionally funded checking account */
async function onboard(
  partner: string, opts: { name?: string; openingCents?: number } = {},
): Promise<{ entity: string; account: string; name: string }> {
  const name = opts.name ?? personaName();
  const e = await api("POST", "/entities", {
    type: "person", name, date_of_birth: "1984-04-14",
    address: "48 Orchard Ln, Springfield, IL 62704",
  }, { key: partner });
  assertEq(e.status, 201, `create member (${show(e.body)})`);
  const a = await api("POST", "/accounts", {
    entity_id: e.body.id, account_type: "checking",
    ...(opts.openingCents ? { opening_deposit_cents: opts.openingCents } : {}),
  }, { key: partner });
  assertEq(a.status, 201, `open account (${show(a.body)})`);
  return { entity: String(e.body.id), account: String(a.body.id), name };
}

async function balanceOf(partner: string, account: string): Promise<number> {
  const r = await api("GET", `/accounts/${account}`, undefined, { key: partner });
  assertEq(r.status, 200, `account read (${show(r.body)})`);
  return r.body.balance;
}

// =============================================================================
// BSA-03 / BSA-04 — CIP at onboarding
// =============================================================================

flow("bsa_program: CIP — an incomplete file is denied without touching the member record; a complete one verifies and opens CDD", async (t) => {
  const partner = await actor("partner");
  const analyst = await actor("cu_admin", ["bsa_compliance"]);
  const as = { key: analyst };
  let m = { entity: "", account: "", name: "" };
  const cip = (extra: Record<string, unknown>) => ({
    entity_ref: m.entity, name: m.name, dob: "1984-04-14",
    address: "48 Orchard Ln, Springfield, IL 62704", ...extra,
  });

  await t.step("the partner onboards a new member", async () => {
    m = await onboard(partner);
  });

  await t.step("CIP is staff work: the partner gets 404, not the endpoint", async () => {
    const r = await api("POST", "/bsa/cip", cip({ id_number: "DL-1" }), { key: partner });
    assertEq(r.status, 404, `partner refused (${show(r.body)})`);
    assertEq(await rowById("verification", `cipv_${m.entity}`), null, "no verification for a refused call");
  });

  await t.step("missing ONE of the four elements is DENIED, not partially complete", async () => {
    const r = await api("POST", "/bsa/cip", cip({}), as); // no id_number
    assertEq(r.status, 409, `denied (${show(r.body)})`);
    const ev = await eventsFor(`verification:cipv_${m.entity}`);
    const denied = ev.find((e) => e.code === "verification.denied");
    assert(denied, `verification.denied logged (${show(ev.map((e) => e.code))})`);
    assertEq(show(denied!.payload.missing_elements), show(["id_number"]), "the missing element is named");
    assert(!ev.some((e) => e.code === "verification.completed"), "no verification.completed");
    assertEq(await rowById("verification", `cipv_${m.entity}`), null, "no verified row");
    assertEq(await rowById("cdd_profile", `cdd_${m.entity}`), null, "no CDD profile for a failed CIP");
  });

  await t.step("a denied CIP does not erase the identifying data the member record already holds", async () => {
    // DEFECT: postCipVerification upserts core.entity BEFORE checking the four elements (bsa_program.ts ~L414-424), so a CIP missing dob writes date_of_birth = NULL (and status = pending) over the member's record
    const r = await api("POST", "/bsa/cip", cip({ dob: undefined, id_number: "DL-1" }), as);
    assertEq(r.status, 409, `denied for missing dob (${show(r.body)})`);
    const ent = await rowById("entity", m.entity);
    assertEq(ent?.date_of_birth, "1984-04-14", "the member's DOB survives a failed CIP");
  });

  await t.step("a complete CIP verifies, stores the elements on the member, and opens CDD in the same act", async () => {
    const r = await api("POST", "/bsa/cip", cip({ id_number: "DL-4471", tin: "***-**-6612" }), as);
    assertEq(r.status, 201, `verified (${show(r.body)})`);
    assertEq(r.body.data?.verified, true, "verified on the response");
    const v = await rowById("verification", `cipv_${m.entity}`);
    assert(v, "verification row written");
    assertEq(v.entity_id, m.entity, "names the member");
    assertEq(v.result, "verified", "result");
    assertEq(v.type, "cip_documentary", "type");
    assertEq(v.match_status, "full_match", "match status recorded");
    assertEq(v.trust_level, "high", "trust level recorded");
    assertEq(v.provenance, "demo", "test-actor evidence is demo");
    const ent = await rowById("entity", m.entity);
    assertEq(ent.date_of_birth, "1984-04-14", "DOB on the member record");
    assertEq(ent.tin, "***-**-6612", "TIN on the member record");
    assert(String(ent.address ?? "").includes("Orchard"), `address on the member record (${show(ent.address)})`);
    const cdd = await rowById("cdd_profile", `cdd_${m.entity}`);
    assert(cdd, "CDD profile opened by the CIP itself");
    assertEq(cdd.entity_id, m.entity, "CDD names the member");
    assertEq(cdd.risk_tier, "low", "default risk tier");
    spans(cdd.last_refreshed_at, cdd.refresh_due_at, 365 * 5, "CDD refresh cycle");
    const vc = await codesFor(`verification:cipv_${m.entity}`);
    assert(vc.includes("verification.completed"), `verification.completed (${vc})`);
    const cc = await codesFor(`cdd_profile:cdd_${m.entity}`);
    assert(cc.includes("cdd.profile.created") && cc.includes("cdd.bo.certified"),
      `cdd.profile.created + cdd.bo.certified (${cc})`);
  });

  await t.step("CIP's OFAC screen ran and left clear evidence with no list behind it", async () => {
    const s = await rowById("ofac_screen", `ofacs_entity_${m.entity}`);
    assert(s, "ofac_screen row for the member");
    assertEq(s.verdict, "clear", "clear");
    assertEq(s.list_version, null, "the stub names no list — and says so");
    assertEq(s.hold_placed_at, null, "no hold on a clean screen");
  });

  await t.step("a CIP with no entity_ref or name is a 400", async () => {
    const r = await api("POST", "/bsa/cip", { name: "Nobody" }, as);
    assertEq(r.status, 400, `refused (${show(r.body)})`);
  });
});

// =============================================================================
// BSA-03 + BSA-05 — an OFAC hit at CIP, held and released by the officer
// =============================================================================

flow("bsa_program: an applicant hits OFAC at CIP — denied, held, escalated, and released only by the officer with a determination", async (t) => {
  const partner = await actor("partner");
  const analyst = await actor("cu_admin", ["bsa_compliance"]);
  const officer = await actor("cu_admin", ["bsa_officer"]);
  const clerk = await actor("cu_admin"); // staff with no BSA duty role
  let m = { entity: "", account: "", name: "" };
  let screen = "";

  await t.step("the partner onboards an applicant whose name is on the (stub) list", async () => {
    m = await onboard(partner, { name: `Dmitri Volkov SDN ${uid()}` });
    screen = `ofacs_entity_${m.entity}`;
  });

  await t.step("CIP with all four elements is still DENIED by the OFAC hit; nothing verified, no CDD", async () => {
    const r = await api("POST", "/bsa/cip", {
      entity_ref: m.entity, name: m.name, dob: "1979-09-09",
      address: "9 Harbor Rd, Springfield, IL 62701", id_number: "P-88812",
    }, { key: analyst });
    assertEq(r.status, 409, `denied (${show(r.body)})`);
    const ev = await eventsFor(`verification:cipv_${m.entity}`);
    const denied = ev.find((e) => e.code === "verification.denied");
    assert(denied, `verification.denied (${show(ev.map((e) => e.code))})`);
    assertEq(denied!.payload.ofac_verdict, "potential_match", "denied on the OFAC verdict");
    assert(ev.some((e) => e.code === "ofac.hold.placed"), "ofac.hold.placed logged");
    assert(!ev.some((e) => e.code === "verification.completed"), "never completed");
    assertEq(await rowById("verification", `cipv_${m.entity}`), null, "no verified row");
    assertEq(await rowById("cdd_profile", `cdd_${m.entity}`), null, "no CDD profile");
    const s = await rowById("ofac_screen", screen);
    assertEq(s?.verdict, "potential_match", "verdict");
    assert(s?.hold_placed_at, "a HOLD is on the applicant");
    assertEq(s?.hold_released_at, null, "not released");
  });

  await t.step("the hit is escalated: an OFAC alert names the applicant for the BSA team", async () => {
    // DEFECT: postCipVerification stamps ofac_screen.escalated_at on a hit (bsa_program.ts ~L444) but never calls raiseAlert, so no bsa_alert exists — the same hit via POST /bsa/ofac/screens does raise one
    const s = await rowById("ofac_screen", screen);
    assert(s?.escalated_at, "the screen says it escalated");
    const a = await core().from("bsa_alert").select("id, status")
      .eq("alert_type", "ofac").eq("entity_hash", m.entity);
    assert(!a.error, `bsa_alert read: ${a.error?.message}`);
    assertEq((a.data ?? []).length, 1, "an open OFAC alert for the applicant");
  });

  await t.step("the partner cannot release its own applicant's hold (404)", async () => {
    const r = await api("POST", `/bsa/ofac/screens/${screen}/release`,
      { released_by: "partner", determination: "looks fine" }, { key: partner });
    assertEq(r.status, 404, `partner refused (${show(r.body)})`);
    assertEq((await rowById("ofac_screen", screen)).hold_released_at, null, "hold intact");
  });

  await t.step("a release with no determination is refused and the hold stays", async () => {
    const r = await api("POST", `/bsa/ofac/screens/${screen}/release`,
      { released_by: "BSA Officer" }, { key: officer });
    assertEq(r.status, 400, `refused (${show(r.body)})`);
    assert((r.body.errors ?? []).some((e: Any) => e.field === "determination"), "names determination");
    assertEq((await rowById("ofac_screen", screen)).hold_released_at, null, "hold intact");
  });

  await t.step("staff without the BSA officer role cannot release an OFAC hold (403)", async () => {
    // DEFECT: postOfacRelease gates only on requireInternalActor (bsa_program.ts ~L143) — any cu_admin/ops token with no BSA role can lift an OFAC hold; bsa.ts gates the comparable SAR decision on bsa_officer
    // Its own hold (an ACH counterparty), so a wrongful release cannot disturb the applicant's.
    const cp = `achcp_${uid()}`;
    const other = `ofacs_ach_counterparty_${cp}`;
    const s = await api("POST", "/bsa/ofac/screens",
      { subject_kind: "ach_counterparty", subject_ref: cp, name: "SDN Remit Co" }, { key: analyst });
    assertEq(s.status, 409, `hold placed (${show(s.body)})`);
    const r = await api("POST", `/bsa/ofac/screens/${other}/release`,
      { released_by: "front desk", determination: "customer says it is not them" }, { key: clerk });
    assertEq(r.status, 403, `role-less staff refused (${show(r.body)})`);
    assertEq((await rowById("ofac_screen", other)).hold_released_at, null, "hold intact");
  });

  await t.step("the officer releases with a documented false-positive determination", async () => {
    const r = await api("POST", `/bsa/ofac/screens/${screen}/release`, {
      released_by: "BSA Officer",
      determination: "false positive — DOB and nationality differ from the SDN entry",
    }, { key: officer });
    assertEq(r.status, 200, `released (${show(r.body)})`);
    const s = await rowById("ofac_screen", screen);
    assert(s.hold_released_at, "release time recorded");
    assertEq(s.released_by, "BSA Officer", "the named releaser is recorded");
    const rel = (await eventsFor(`ofac_screen:${screen}`)).find((e) => e.code === "ofac.hold.released");
    assert(rel, "ofac.hold.released logged");
    assert(String(rel!.payload.determination).startsWith("false positive"), "the determination is retained");
    assertEq(rel!.provenance, "demo", "demo evidence");
  });

  await t.step("release on an unknown screen is 404", async () => {
    const r = await api("POST", `/bsa/ofac/screens/ofacs_entity_nope_${uid()}/release`,
      { released_by: "BSA Officer", determination: "n/a" }, { key: officer });
    assertEq(r.status, 404, `unknown (${show(r.body)})`);
  });
});

// =============================================================================
// BSA-05 — re-screening members already banking with us
// =============================================================================

flow("bsa_program: a member is re-screened and hits — the hold stops their money until the officer clears it", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  const officer = await actor("cu_admin", ["bsa_officer"]);
  let clean = { entity: "", account: "", name: "" };
  let held = { entity: "", account: "", name: "" };
  const screenOf = (e: string) => `ofacs_entity_${e}`;

  await t.step("the partner onboards two funded members", async () => {
    clean = await onboard(partner, { openingCents: 200_000 });
    held = await onboard(partner, { openingCents: 200_000 });
  });

  await t.step("a clean re-screen leaves evidence: screened-and-clear is not never-screened", async () => {
    const r = await api("POST", "/bsa/ofac/screens",
      { subject_kind: "entity", subject_ref: clean.entity, name: clean.name }, { key: ops });
    assertEq(r.status, 201, `screened (${show(r.body)})`);
    assertEq(r.body.data?.verdict, "clear", "clear");
    const s = await rowById("ofac_screen", screenOf(clean.entity));
    assertEq(s.list_version, null, "list_version is null — the stub has no list");
    assertEq(s.hold_placed_at, null, "no hold");
    const ev = await eventsFor(`ofac_screen:${screenOf(clean.entity)}`);
    assert(ev.some((e) => e.code === "ofac.screened"), "ofac.screened");
    const cl = ev.find((e) => e.code === "ofac.cleared");
    assert(cl, "ofac.cleared");
    assertEq(cl!.payload["ofac.list_version"], null, "the event says no list too");
  });

  await t.step("partners cannot screen (404); a bad subject_kind is 400", async () => {
    const p = await api("POST", "/bsa/ofac/screens",
      { subject_kind: "entity", subject_ref: clean.entity, name: clean.name }, { key: partner });
    assertEq(p.status, 404, `partner refused (${show(p.body)})`);
    const b = await api("POST", "/bsa/ofac/screens",
      { subject_kind: "pet", subject_ref: clean.entity, name: clean.name }, { key: ops });
    assertEq(b.status, 400, `bad kind (${show(b.body)})`);
  });

  await t.step("a list update makes the member a potential match: 409, HOLD placed, escalated, alert opened", async () => {
    const r = await api("POST", "/bsa/ofac/screens",
      { subject_kind: "entity", subject_ref: held.entity, name: `${held.name} SDN` }, { key: ops });
    assertEq(r.status, 409, `hold (${show(r.body)})`);
    const s = await rowById("ofac_screen", screenOf(held.entity));
    assertEq(s.verdict, "potential_match", "verdict");
    assert(s.hold_placed_at && s.escalated_at, "held and escalated");
    const c = await codesFor(`ofac_screen:${screenOf(held.entity)}`);
    for (const code of ["ofac.screened", "ofac.hold.placed", "ofac.escalated"]) {
      assert(c.includes(code), `${code} logged (${c})`);
    }
    const a = await rowById("bsa_alert", `alert_${held.entity}_ofac`);
    assert(a, "an OFAC alert for the member");
    assertEq(a.status, "open", "open for triage");
    assertEq(a.entity_hash, held.entity, "names the member");
    assertEq(a.provenance, "demo", "demo evidence");
  });

  await t.step("while held, the member's money does not move", async () => {
    // Regression guard (bug found by this flow, fixed 2026-10-05): the hold was
    // only a core.ofac_screen row that no rail read; runGate now refuses 423.
    const before = await balanceOf(partner, held.account);
    const r = await api("POST", "/transfers", {
      source_account_id: held.account, destination_account_id: clean.account,
      amount_cents: 25_000, description: "flow: transfer while OFAC-held",
    }, { key: partner });
    assert(r.status >= 400 && r.status < 500, `a held member's transfer is refused (got ${r.status}: ${show(r.body)})`);
    assertEq(await balanceOf(partner, held.account), before, "balance unchanged");
  });

  await t.step("the officer clears the hold; the member transacts again", async () => {
    const rel = await api("POST", `/bsa/ofac/screens/${screenOf(held.entity)}/release`, {
      released_by: "BSA Officer", determination: "false positive — alias collision, DOB mismatch",
    }, { key: officer });
    assertEq(rel.status, 200, `released (${show(rel.body)})`);
    const r = await api("POST", "/transfers", {
      source_account_id: held.account, destination_account_id: clean.account,
      amount_cents: 10_000, description: "flow: transfer after release",
    }, { key: partner });
    assert(r.status === 200 || r.status === 201, `transfer after release (${r.status}: ${show(r.body)})`);
  });

  await t.step("releasing a screen that placed no hold is a 409", async () => {
    const r = await api("POST", `/bsa/ofac/screens/${screenOf(clean.entity)}/release`,
      { released_by: "BSA Officer", determination: "n/a" }, { key: officer });
    assertEq(r.status, 409, `nothing to release (${show(r.body)})`);
  });

  await t.step("the OFAC annual report counts the REPORTING YEAR's holds from the register", async () => {
    // DEFECT: postOfacAnnualReport selects every ofac_screen row with no reporting_year filter (bsa_program.ts ~L740), so any year's report carries all-time counts
    // A year before the core existed had no screens, so its blocked count is 0.
    const year = 1950 + Math.floor(Math.random() * 40);
    const bad = await api("POST", "/bsa/ofac/annual-report", { reporting_year: year }, { key: officer });
    assertEq(bad.status, 400, `filed_by is required (${show(bad.body)})`);
    const r = await api("POST", "/bsa/ofac/annual-report",
      { reporting_year: year, filed_by: "BSA Officer" }, { key: officer });
    assertEq(r.status, 201, `filed (${show(r.body)})`);
    const filed = (await eventsFor(`ofac_screen:ofacann_${year}`)).find((e) => e.code === "ofac.annual_report.filed");
    assert(filed, "ofac.annual_report.filed logged");
    assertEq(filed!.payload["ofac.list_version"], null, "the report says it screened against no list");
    assertEq(r.body.data?.blocked, 0, `no holds were placed in ${year}`);
  });
});

// =============================================================================
// BSA-18 / BSA-17 — PEP hit opens senior-approval EDD
// =============================================================================

flow("bsa_program: a PEP hit opens senior-approval EDD in the same act; only the officer can sign it off", async (t) => {
  const partner = await actor("partner");
  const analyst = await actor("cu_admin", ["bsa_investigator"]);
  const officer = await actor("cu_admin", ["bsa_officer"]);
  let ordinary = { entity: "", account: "", name: "" };
  let pep = { entity: "", account: "", name: "" };
  const eddOf = (e: string) => `edd_${e}_pep`;

  await t.step("the partner onboards two members", async () => {
    ordinary = await onboard(partner);
    pep = await onboard(partner);
  });

  await t.step("a clean PEP screen is evidenced and opens no EDD", async () => {
    const r = await api("POST", "/bsa/pep/screens",
      { entity_ref: ordinary.entity, name: ordinary.name }, { key: analyst });
    assertEq(r.status, 201, `screened (${show(r.body)})`);
    assertEq(r.body.data?.verdict, "clear", "clear");
    const s = await rowById("pep_screen", `peps_${ordinary.entity}`);
    assertEq(s.verdict, "clear", "row verdict");
    assertEq(s.list_version, null, "no list");
    assertEq(s.edd_profile_id, null, "no EDD linked");
    assertEq(await rowById("edd_profile", eddOf(ordinary.entity)), null, "no EDD opened");
    const c = await codesFor(`pep_screen:peps_${ordinary.entity}`);
    assert(c.includes("pep.screened") && !c.includes("pep.hit"), `screened, not hit (${c})`);
  });

  await t.step("a foreign-official hit opens the EDD — 30-day clock, senior approval required", async () => {
    const p = await api("POST", "/bsa/pep/screens",
      { entity_ref: pep.entity, name: pep.name, pep_category: "foreign_official" }, { key: partner });
    assertEq(p.status, 404, `partner cannot screen (${show(p.body)})`);
    const r = await api("POST", "/bsa/pep/screens",
      { entity_ref: pep.entity, name: pep.name, pep_category: "foreign_official" }, { key: analyst });
    assertEq(r.status, 201, `screened (${show(r.body)})`);
    assertEq(r.body.data?.verdict, "hit", "hit");
    const s = await rowById("pep_screen", `peps_${pep.entity}`);
    assertEq(s.edd_profile_id, eddOf(pep.entity), "the screen links the EDD it opened");
    const e = await rowById("edd_profile", eddOf(pep.entity));
    assert(e, "EDD opened in the same act");
    assertEq(e.category, "pep", "category");
    assertEq(e.senior_approval_required, true, "senior sign-off required");
    assertEq(e.completed_at, null, "open");
    spans(e.opened_at, e.due_at, 30, "EDD due window");
    const c = await codesFor(`pep_screen:peps_${pep.entity}`);
    for (const code of ["pep.designated", "pep.hit", "edd.pep.opened", "pep.refresh.scheduled", "risk.trigger_edd"]) {
      assert(c.includes(code), `${code} logged (${c})`);
    }
  });

  await t.step("completing with no findings is refused", async () => {
    const r = await api("POST", `/bsa/edd/${eddOf(pep.entity)}/complete`, {}, { key: analyst });
    assertEq(r.status, 400, `refused (${show(r.body)})`);
    assertEq((await rowById("edd_profile", eddOf(pep.entity))).completed_at, null, "still open");
  });

  await t.step("the analyst cannot close a PEP EDD without senior sign-off", async () => {
    const r = await api("POST", `/bsa/edd/${eddOf(pep.entity)}/complete`,
      { findings: "source of wealth documented" }, { key: analyst });
    assertEq(r.status, 409, `sign-off required (${show(r.body)})`);
    assertEq((await rowById("edd_profile", eddOf(pep.entity))).completed_at, null, "still open");
  });

  await t.step("the officer signs off: completed, approver recorded, next refresh scheduled", async () => {
    const r = await api("POST", `/bsa/edd/${eddOf(pep.entity)}/complete`, {
      findings: "source of wealth: public salary + inheritance, documented", approved_by: "BSA Officer",
    }, { key: officer });
    assertEq(r.status, 200, `completed (${show(r.body)})`);
    const e = await rowById("edd_profile", eddOf(pep.entity));
    assert(e.completed_at, "completed");
    assertEq(e.approved_by, "BSA Officer", "approver recorded");
    assert(String(e.findings).startsWith("source of wealth"), "findings retained");
    const ev = await eventsFor(`edd_profile:${eddOf(pep.entity)}`);
    const c = ev.map((x) => x.code);
    for (const code of ["edd.completed", "edd.category.approved", "edd.refresh.completed", "pep.refresh.completed", "edd.pep.completed"]) {
      assert(c.includes(code), `${code} logged (${c})`);
    }
    assertEq(ev.find((x) => x.code === "edd.completed")!.payload.completed_late, false, "on time");
    const refresh = ev.find((x) => x.code === "edd.refresh.completed")!;
    spans(e.completed_at, refresh.payload.next_refresh_due_at, 365, "EDD is re-reviewed annually");
  });

  await t.step("the analyst cannot supply the sign-off by typing a name — it takes the officer's credential", async () => {
    // DEFECT: postEddCompletion accepts any non-empty approved_by string from any internal token (bsa_program.ts ~L241-247); senior approval is self-asserted, never bound to a bsa_officer actor
    // A second PEP EDD (opened directly on the other member), so a wrongful completion cannot disturb the first.
    const id = eddOf(ordinary.entity);
    const o = await api("POST", "/bsa/edd",
      { entity_ref: ordinary.entity, category: "pep", trigger_reason: "adverse media: newly appointed minister" }, { key: analyst });
    assertEq(o.status, 201, `opened (${show(o.body)})`);
    assertEq(o.body.data?.senior_approval_required, true, "pep needs sign-off");
    const r = await api("POST", `/bsa/edd/${id}/complete`,
      { findings: "source of wealth documented", approved_by: "BSA Officer" }, { key: analyst });
    assertEq(r.status, 403, `the analyst is refused (${show(r.body)})`);
    assertEq((await rowById("edd_profile", id)).completed_at, null, "still open");
  });

  await t.step("a screen with no name is 400", async () => {
    const r = await api("POST", "/bsa/pep/screens", { entity_ref: pep.entity }, { key: analyst });
    assertEq(r.status, 400, `refused (${show(r.body)})`);
  });
});

// =============================================================================
// BSA-04 / BSA-17 — EDD opened directly for a high-risk relationship
// =============================================================================

flow("bsa_program: EDD for high-risk relationships — an MSB closes on findings, a correspondent needs sign-off", async (t) => {
  const partner = await actor("partner");
  const analyst = await actor("cu_admin", ["bsa_investigator"]);
  const officer = await actor("cu_admin", ["bsa_officer"]);
  let msb = "";
  let corr = "";

  await t.step("the partner onboards a money-services business and a foreign correspondent", async () => {
    for (const [name, tin] of [[`Quickcash MSB LLC ${uid()}`, "45-1112223"], [`Banco Austral ${uid()}`, "98-7654321"]]) {
      const r = await api("POST", "/entities", { type: "business", name, tin }, { key: partner });
      assertEq(r.status, 201, `business (${show(r.body)})`);
      if (!msb) msb = String(r.body.id);
      else corr = String(r.body.id);
    }
  });

  await t.step("the analyst opens EDD on the MSB: 30-day clock, no senior sign-off, triggers logged", async () => {
    const p = await api("POST", "/bsa/edd",
      { entity_ref: msb, category: "msb", trigger_reason: "registered MSB" }, { key: partner });
    assertEq(p.status, 404, `partner refused (${show(p.body)})`);
    const r = await api("POST", "/bsa/edd",
      { entity_ref: msb, category: "msb", trigger_reason: "registered MSB" }, { key: analyst });
    assertEq(r.status, 201, `opened (${show(r.body)})`);
    assertEq(r.body.data?.senior_approval_required, false, "ordinary category");
    const e = await rowById("edd_profile", `edd_${msb}_msb`);
    assertEq(e.senior_approval_required, false, "row agrees");
    spans(e.opened_at, e.due_at, 30, "EDD due window");
    const c = await codesFor(`edd_profile:edd_${msb}_msb`);
    assert(c.includes("risk.trigger_edd") && c.includes("edd.opened"), `trigger + opened (${c})`);
  });

  await t.step("an unknown category or missing trigger reason is 400", async () => {
    const a = await api("POST", "/bsa/edd", { entity_ref: msb, category: "casino", trigger_reason: "x" }, { key: analyst });
    assertEq(a.status, 400, `bad category (${show(a.body)})`);
    const b = await api("POST", "/bsa/edd", { entity_ref: msb, category: "msb" }, { key: analyst });
    assertEq(b.status, 400, `no trigger (${show(b.body)})`);
  });

  await t.step("the analyst completes the MSB EDD on findings alone", async () => {
    const r = await api("POST", `/bsa/edd/edd_${msb}_msb/complete`,
      { findings: "FinCEN MSB registration verified; AML program on file" }, { key: analyst });
    assertEq(r.status, 200, `completed (${show(r.body)})`);
    const e = await rowById("edd_profile", `edd_${msb}_msb`);
    assert(e.completed_at, "completed");
    assertEq(e.approved_by, null, "no approver needed or recorded");
  });

  await t.step("a correspondent EDD needs senior sign-off: refused without, completed with the officer", async () => {
    const o = await api("POST", "/bsa/edd",
      { entity_ref: corr, category: "correspondent", trigger_reason: "foreign correspondent bank" }, { key: analyst });
    assertEq(o.status, 201, `opened (${show(o.body)})`);
    assertEq(o.body.data?.senior_approval_required, true, "senior category");
    const no = await api("POST", `/bsa/edd/edd_${corr}_correspondent/complete`,
      { findings: "Wolfsberg questionnaire on file" }, { key: analyst });
    assertEq(no.status, 409, `sign-off required (${show(no.body)})`);
    assertEq((await rowById("edd_profile", `edd_${corr}_correspondent`)).completed_at, null, "still open");
    const ok = await api("POST", `/bsa/edd/edd_${corr}_correspondent/complete`,
      { findings: "Wolfsberg questionnaire on file", approved_by: "BSA Officer" }, { key: officer });
    assertEq(ok.status, 200, `signed off (${show(ok.body)})`);
    assertEq((await rowById("edd_profile", `edd_${corr}_correspondent`)).approved_by, "BSA Officer", "approver");
  });

  await t.step("completing an unknown EDD is 404", async () => {
    const r = await api("POST", `/bsa/edd/edd_nope_${uid()}/complete`, { findings: "x" }, { key: analyst });
    assertEq(r.status, 404, `unknown (${show(r.body)})`);
  });
});

// =============================================================================
// BSA-11 — FinCEN 314(a)
// =============================================================================

flow("bsa_program: a 314(a) request is logged with its 14-day deadline, searched and answered — zero matches included; a late answer is marked late", async (t) => {
  const partner = await actor("partner");
  const compliance = await actor("cu_admin", ["bsa_compliance"]);
  const as = { key: compliance };
  const ref = `314A-${uid()}`;
  const lateRef = `314A-LATE-${uid()}`;
  const fid = `filing_314a_${ref}`;

  await t.step("the request arrives: filing row, response due 14 days out, receipt logged", async () => {
    const p = await api("POST", "/bsa/314a", { reference: ref }, { key: partner });
    assertEq(p.status, 404, `partner refused (${show(p.body)})`);
    const r = await api("POST", "/bsa/314a", { reference: ref }, as);
    assertEq(r.status, 201, `logged (${show(r.body)})`);
    assertEq(r.body.data?.id, fid, "id");
    const f = await rowById("filing", fid);
    assertEq(f.kind, "fincen_314a", "kind");
    spans(f.received_at, f.response_due_at, 14, "314(a) response window");
    assertEq(f.responded_at, null, "not yet answered");
    assert((await codesFor(`filing:${fid}`)).includes("regulator.request.received"), "receipt logged");
  });

  await t.step("a response with no match count is refused — 'no match' must be stated", async () => {
    const r = await api("POST", `/bsa/314a/${fid}/respond`, { responded_by: "BSA Compliance" }, as);
    assertEq(r.status, 400, `refused (${show(r.body)})`);
    assertEq((await rowById("filing", fid)).responded_at, null, "still unanswered");
  });

  await t.step("searched, zero matches, answered on time", async () => {
    const r = await api("POST", `/bsa/314a/${fid}/respond`, { match_count: 0, responded_by: "BSA Compliance" }, as);
    assertEq(r.status, 200, `answered (${show(r.body)})`);
    const f = await rowById("filing", fid);
    assertEq(f.match_count, 0, "zero recorded, not null");
    assert(f.searched_at && f.responded_at, "searched and responded times");
    assertEq(f.responded_by, "BSA Compliance", "who answered");
    const ev = (await eventsFor(`filing:${fid}`)).find((e) => e.code === "filing.fincen_314a");
    assert(ev, "filing.fincen_314a logged");
    assertEq(ev!.payload.responded_late, false, "on time");
    assertEq(ev!.payload["filing.match_count"], 0, "count on the event");
  });

  await t.step("a request received 20 days ago and answered today is recorded LATE", async () => {
    const r = await api("POST", "/bsa/314a",
      { reference: lateRef, received_at: new Date(Date.now() - 20 * DAY).toISOString() }, as);
    assertEq(r.status, 201, `logged (${show(r.body)})`);
    const a = await api("POST", `/bsa/314a/filing_314a_${lateRef}/respond`,
      { match_count: 1, responded_by: "BSA Compliance" }, as);
    assertEq(a.status, 200, `answered (${show(a.body)})`);
    const ev = (await eventsFor(`filing:filing_314a_${lateRef}`)).find((e) => e.code === "filing.fincen_314a");
    assertEq(ev?.payload.responded_late, true, "late is on the record");
  });

  await t.step("no reference is 400; answering an unknown request is 404", async () => {
    assertEq((await api("POST", "/bsa/314a", {}, as)).status, 400, "no reference");
    const r = await api("POST", `/bsa/314a/filing_314a_nope_${uid()}/respond`, { match_count: 0, responded_by: "x" }, as);
    assertEq(r.status, 404, `unknown (${show(r.body)})`);
  });
});

// =============================================================================
// BSA-09 — monetary instruments sold for cash
// =============================================================================

flow("bsa_program: a teller sells cashier's checks — below $3k nothing, $3k–$10k needs ID and is logged and screened, $10k+ is the CTR's", async (t) => {
  const partner = await actor("partner");
  const teller = await actor("cu_admin");
  const as = { key: teller };
  const run = uid();
  let member = { entity: "", account: "", name: "" };
  const mi = (b: Record<string, unknown>) => api("POST", "/bsa/monetary-instruments", b, as);

  await t.step("the partner onboards the purchasing member", async () => {
    member = await onboard(partner);
  });

  await t.step("a $500 money order: recorded, no log entry", async () => {
    const r = await mi({ instrument_type: "money_order", amount_cents: 50_000, purchaser_name: member.name, purchaser_ref: member.entity });
    assertEq(r.status, 201, `sold (${show(r.body)})`);
    assertEq(r.body.data?.log_required, false, "below the band");
    const row = await rowById("monetary_instrument", r.body.data.id);
    assertEq(row.log_required, false, "row agrees");
    const c = await codesFor(`monetary_instrument:${r.body.data.id}`);
    assert(c.includes("monetary_instrument.purchased"), `purchase logged (${c})`);
    assert(!c.includes("mi.log_entry.created"), "no log entry below $3,000");
  });

  await t.step("$5,000 with no identification is REFUSED and leaves no instrument", async () => {
    const name = `Anonymous Buyer ${run}`;
    const r = await mi({ instrument_type: "cashiers_check", amount_cents: 500_000, purchaser_name: name });
    assertEq(r.status, 409, `refused (${show(r.body)})`);
    const rows = await core().from("monetary_instrument").select("id").eq("purchaser_name", name);
    assertEq((rows.data ?? []).length, 0, "nothing issued");
  });

  await t.step("$5,000 with identification is logged centrally and the purchaser is screened", async () => {
    const r = await mi({
      instrument_type: "cashiers_check", amount_cents: 500_000, purchaser_name: member.name,
      purchaser_ref: member.entity, purchaser_id_type: "drivers_license", purchaser_id_number: "IL-D123-4567",
      purchaser_dob: "1984-04-14",
    });
    assertEq(r.status, 201, `sold (${show(r.body)})`);
    const id = r.body.data.id;
    const row = await rowById("monetary_instrument", id);
    assertEq(row.log_required, true, "in the band");
    assertEq(row.id_verified, true, "ID verified");
    assertEq(row.purchaser_id_number, "IL-D123-4567", "ID retained");
    assertEq(row.provenance, "demo", "demo evidence");
    const c = await codesFor(`monetary_instrument:${id}`);
    for (const code of ["mi.log_entry.created", "mi.central_log.updated", "monetary_instrument.logged", "ofac.cleared"]) {
      assert(c.includes(code), `${code} logged (${c})`);
    }
  });

  await t.step("a $10,000 bank draft goes to the CTR band instead of the log", async () => {
    const r = await mi({
      instrument_type: "bank_draft", amount_cents: 1_000_000, purchaser_name: member.name,
      purchaser_id_type: "passport", purchaser_id_number: "P-5550001",
    });
    assertEq(r.status, 201, `sold (${show(r.body)})`);
    assertEq(r.body.data?.log_required, false, "not the log");
    const c = await codesFor(`monetary_instrument:${r.body.data.id}`);
    assert(c.includes("monetary_instrument.ctr_band"), `ctr_band logged (${c})`);
    assert(!c.includes("mi.log_entry.created"), "no log entry at $10,000");
  });

  await t.step("an in-band purchaser who hits OFAC does not walk out with the instrument", async () => {
    // DEFECT: postMonetaryInstrument screens the purchaser AFTER inserting the instrument and only emits 'ofac.hold.placed' on the MI (bsa_program.ts ~L433-440) — no ofac_screen hold, no alert, and the sale is 201
    const name = `Ivan Petrov SDN ${run}`;
    const r = await mi({
      instrument_type: "cashiers_check", amount_cents: 400_000, purchaser_name: name,
      purchaser_id_type: "passport", purchaser_id_number: "P-9990001",
    });
    assertEq(r.status, 409, `sale refused on the OFAC hit (${r.status}: ${show(r.body)})`);
    const rows = await core().from("monetary_instrument").select("id").eq("purchaser_name", name);
    assertEq((rows.data ?? []).length, 0, "no instrument issued to the potential match");
  });

  await t.step("partner 404; an unknown instrument type is 400", async () => {
    const p = await api("POST", "/bsa/monetary-instruments",
      { instrument_type: "money_order", amount_cents: 50_000, purchaser_name: "x" }, { key: partner });
    assertEq(p.status, 404, `partner (${show(p.body)})`);
    const b = await mi({ instrument_type: "gift_card", amount_cents: 50_000, purchaser_name: "x" });
    assertEq(b.status, 400, `bad type (${show(b.body)})`);
  });
});

// =============================================================================
// BSA-10 — the Travel Rule on a real wire
// =============================================================================

flow("bsa_program: a $5,000 wire carries its Travel Rule record; without the originator it is refused", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  let m = { entity: "", account: "", name: "" };
  let wire = "";
  const BENE = { name: "Harbor Supply Co", country: "US", routing_number: "021000021", account_number: "000123456789" };

  await t.step("the partner onboards a funded member and prepares a $5,000 wire", async () => {
    m = await onboard(partner, { openingCents: 1_000_000 });
    const r = await api("POST", "/payments/wire/prepare", {
      source_account_id: m.account, amount_cents: 500_000, beneficiary: BENE, purpose: "flow: travel rule",
    }, { key: partner });
    assertEq(r.status, 201, `prepared (${show(r.body)})`);
    wire = String(r.body.id);
  });

  await t.step("operations screens the wire's beneficiary: clear, evidenced", async () => {
    const r = await api("POST", "/bsa/ofac/screens",
      { subject_kind: "wire_beneficiary", subject_ref: wire, name: BENE.name }, { key: ops });
    assertEq(r.status, 201, `screened (${show(r.body)})`);
    assertEq((await rowById("ofac_screen", `ofacs_wire_beneficiary_${wire}`))?.verdict, "clear", "clear");
  });

  await t.step("a record with no originator is refused and the gap is logged", async () => {
    const p = await api("POST", "/bsa/travel-rule",
      { wire_ref: wire, amount_cents: 500_000, beneficiary: { name: BENE.name } }, { key: partner });
    assertEq(p.status, 404, `partner (${show(p.body)})`);
    const r = await api("POST", "/bsa/travel-rule",
      { wire_ref: wire, amount_cents: 500_000, beneficiary: { name: BENE.name } }, { key: ops });
    assertEq(r.status, 409, `refused (${show(r.body)})`);
    const c = await codesFor(`wire_transfer:${wire}`);
    assert(c.includes("wire_transfer.record.missing"), `record.missing logged (${c})`);
    assert(!c.includes("wire_transfer.record.retained"), "nothing retained");
    assertEq(await rowById("originator", `orig_${wire}`), null, "no originator row");
  });

  await t.step("the threshold is the WIRE's amount: understating it, or naming no real wire, gets no exemption", async () => {
    // Regression guard (bug found by this flow, fixed 2026-10-03): the record used to trust the caller's amount and never load the wire
    const under = await api("POST", "/bsa/travel-rule", { wire_ref: wire, amount_cents: 299_999 }, { key: ops });
    assertEq(under.status, 409, `understated amount on a $5,000 wire is refused (${under.status}: ${show(under.body)})`);
    const ghost = await api("POST", "/bsa/travel-rule", {
      wire_ref: `wire_ghost_${uid()}`, amount_cents: 500_000,
      originator: { name: "A", address: "B" }, beneficiary: { name: "C" },
    }, { key: ops });
    assertEq(ghost.status, 404, `no such wire (${ghost.status}: ${show(ghost.body)})`);
  });

  await t.step("the complete record is RETAINED AS A ROW tied to the wire", async () => {
    const r = await api("POST", "/bsa/travel-rule", {
      wire_ref: wire, amount_cents: 500_000,
      originator: { name: m.name, address: "48 Orchard Ln, Springfield, IL 62704", account: m.account, routing_number: "071000013" },
      beneficiary: { name: BENE.name, account: BENE.account_number },
    }, { key: ops });
    assertEq(r.status, 201, `retained (${show(r.body)})`);
    const o = await rowById("originator", `orig_${wire}`);
    assert(o, "originator row");
    assertEq(o.wire_ref, wire, "tied to the wire");
    assertEq(o.name, m.name, "originator name");
    assert(String(o.address).includes("Orchard"), "originator address");
    assertEq(o.reference, m.account, "originator account");
    assertEq(o.beneficiary_name, BENE.name, "beneficiary name");
    assertEq(Number(o.amount_cents), 500_000, "amount");
    assertEq(o.provenance, "demo", "demo evidence");
    assert((await codesFor(`wire_transfer:${wire}`)).includes("wire_transfer.record.retained"), "retained logged");
  });

  await t.step("below $3,000 the rule does not attach on a real small wire; no wire_ref is 400", async () => {
    const prep = await api("POST", "/payments/wire/prepare", {
      source_account_id: m.account, amount_cents: 299_999, beneficiary: BENE, purpose: "flow: travel rule small",
    }, { key: partner });
    assertEq(prep.status, 201, `small wire prepared (${show(prep.body)})`);
    const small = await api("POST", "/bsa/travel-rule", { wire_ref: String(prep.body.id), amount_cents: 299_999 }, { key: ops });
    assertEq(small.status, 201, `accepted (${show(small.body)})`);
    const bad = await api("POST", "/bsa/travel-rule", { amount_cents: 500_000 }, { key: ops });
    assertEq(bad.status, 400, `no wire_ref (${show(bad.body)})`);
  });
});

// =============================================================================
// BSA-13 — FBAR
// =============================================================================

flow("bsa_program: FBAR — two foreign accounts cross the threshold only together, the filing needs its E-Filing ref, a nil year is recorded", async (t) => {
  const partner = await actor("partner");
  const compliance = await actor("cu_admin", ["bsa_compliance"]);
  const as = { key: compliance };
  // fbar_filing is one row per reporting year for the whole institution and
  // aggregates every fbar_account of that year. Real years are shared with
  // every other run, so each run owns an otherwise-unused year.
  // Kept below 9999: a five-digit year's due_at serialises as "+010000-…".
  const YEAR = 3000 + Math.floor(Math.random() * 3000);
  const NIL_YEAR = YEAR + 3000;
  const run = uid();

  await t.step("compliance registers two Swiss accounts, $6,000 and $7,000 maximum value", async () => {
    const p = await api("POST", "/bsa/fbar/accounts", {
      account_ref: `CH-${run}-1`, country: "CH", institution_name: "Alpine Bank", max_value_cents: 600_000, reporting_year: YEAR,
    }, { key: partner });
    assertEq(p.status, 404, `partner (${show(p.body)})`);
    for (const [n, v] of [[1, 600_000], [2, 700_000]]) {
      const r = await api("POST", "/bsa/fbar/accounts", {
        account_ref: `CH-${run}-${n}`, country: "CH", institution_name: "Alpine Bank", max_value_cents: v, reporting_year: YEAR,
      }, as);
      assertEq(r.status, 201, `account ${n} (${show(r.body)})`);
      const row = await rowById("fbar_account", r.body.data.id);
      assertEq(Number(row.max_value_cents), v, "max value recorded");
      assert((await codesFor(`fbar_account:${r.body.data.id}`)).includes("fbar.account.added"), "added logged");
    }
    const bad = await api("POST", "/bsa/fbar/accounts", { account_ref: `CH-${run}-3`, country: "CH" }, as);
    assertEq(bad.status, 400, `no value/year (${show(bad.body)})`);
  });

  await t.step("the determination is on the AGGREGATE: $13,000 is reportable, due April 15 next year", async () => {
    const r = await api("POST", "/bsa/fbar/filings", { reporting_year: YEAR }, as);
    assertEq(r.status, 201, `determined (${show(r.body)})`);
    assertEq(r.body.data?.aggregate_max_cents, 1_300_000, "aggregate");
    assertEq(r.body.data?.required, true, "a per-account test is the classic FBAR error");
    const f = await rowById("fbar_filing", `fbar_${YEAR}`);
    assertEq(f.required, true, "row agrees");
    assertEq(new Date(f.due_at).toISOString().slice(0, 10), `${YEAR + 1}-04-15`, "due date");
    assertEq(f.filed_at, null, "not yet filed");
    const c = await codesFor(`fbar_filing:fbar_${YEAR}`);
    assert(c.includes("fbar.filing.timer") && !c.includes("fbar.nil.determined"), `timer, not nil (${c})`);
  });

  await t.step("filing without the BSA E-Filing reference is refused; with it, filed", async () => {
    const no = await api("POST", "/bsa/fbar/filings", { reporting_year: YEAR, filed_by: "BSA Compliance" }, as);
    assertEq(no.status, 400, `refused (${show(no.body)})`);
    assertEq((await rowById("fbar_filing", `fbar_${YEAR}`)).filed_at, null, "still unfiled");
    const ok = await api("POST", "/bsa/fbar/filings",
      { reporting_year: YEAR, filed_by: "BSA Compliance", bsa_efiling_ref: `BSAE-${run}` }, as);
    assertEq(ok.status, 201, `filed (${show(ok.body)})`);
    const f = await rowById("fbar_filing", `fbar_${YEAR}`);
    assert(f.filed_at, "filed");
    assertEq(f.bsa_efiling_ref, `BSAE-${run}`, "E-Filing ref");
    const filed = (await eventsFor(`fbar_filing:fbar_${YEAR}`)).find((e) => e.code === "fbar.filed");
    assertEq(filed?.payload["fbar.efiling_ref"], `BSAE-${run}`, "fbar.filed carries the ref");
  });

  await t.step("a year with no foreign accounts records a NIL determination, not silence", async () => {
    const r = await api("POST", "/bsa/fbar/filings", { reporting_year: NIL_YEAR }, as);
    assertEq(r.status, 201, `determined (${show(r.body)})`);
    assertEq(r.body.data?.required, false, "not required");
    assertEq(r.body.data?.aggregate_max_cents, 0, "nothing held");
    const c = await codesFor(`fbar_filing:fbar_${NIL_YEAR}`);
    assert(c.includes("fbar.nil.determined") && !c.includes("fbar.filed"), `nil, not filed (${c})`);
  });
});

// =============================================================================
// BSA-19 — regulatory change management
// =============================================================================

flow("bsa_program: a GTO is assessed not-applicable with a retained record; an advisory waits for assessment, then is assessed", async (t) => {
  const partner = await actor("partner");
  const officer = await actor("cu_admin", ["bsa_officer"]);
  const as = { key: officer };
  const gto = `GTO-${uid()}`;
  const adv = `ADV-${uid()}`;

  await t.step("a FinCEN GTO is logged and assessed in one act: retention record + implemented", async () => {
    const p = await api("POST", "/bsa/regulatory-changes", { kind: "gto", reference: gto }, { key: partner });
    assertEq(p.status, 404, `partner (${show(p.body)})`);
    const r = await api("POST", "/bsa/regulatory-changes", {
      kind: "gto", reference: gto, issued_by: "FinCEN",
      applicability: "not applicable — no title insurance business", assessed_by: "BSA Officer",
    }, as);
    assertEq(r.status, 201, `logged (${show(r.body)})`);
    const ch = await rowById("regulatory_change", `regchg_${gto}`);
    assert(ch.assessed_at, "assessed");
    assertEq(ch.assessed_by, "BSA Officer", "assessor");
    assert(String(ch.applicability).startsWith("not applicable"), "applicability recorded");
    const rec = await rowById("record", `rec_regchg_${gto}`);
    assert(rec, "a retention record of the assessment exists");
    assertEq(rec.record_class, "regulatory_assessment", "record class");
    spans(rec.retention_anchor, rec.retention_expires_at, 365 * 5, "five-year retention");
    const ev = await eventsFor(`regulatory_change:regchg_${gto}`);
    const c = ev.map((e) => e.code);
    for (const code of ["regulatory.change.identified", "regulatory.change_required", "regulatory.change.assessed", "regulatory.change_implemented"]) {
      assert(c.includes(code), `${code} logged (${c})`);
    }
    assertEq(ev.find((e) => e.code === "regulatory.change_implemented")!.payload.implemented, true,
      "not-applicable is implemented by definition");
  });

  await t.step("an advisory with no assessment is identified, on a 30-day clock, NOT implemented", async () => {
    const r = await api("POST", "/bsa/regulatory-changes", { kind: "advisory", reference: adv }, as);
    assertEq(r.status, 201, `logged (${show(r.body)})`);
    const ch = await rowById("regulatory_change", `regchg_${adv}`);
    assertEq(ch.assessed_at, null, "not assessed");
    spans(ch.received_at, ch.assessment_due_at, 30, "assessment window");
    const c = await codesFor(`regulatory_change:regchg_${adv}`);
    assert(c.includes("regulatory.change.identified"), `identified (${c})`);
    assert(!c.includes("regulatory.change_implemented"), "not implemented");
    assert(await rowById("record", `rec_regchg_${adv}`), "retention record exists from receipt");
  });

  await t.step("the officer assesses the advisory as applicable with controls updated: now implemented", async () => {
    const r = await api("POST", "/bsa/regulatory-changes", {
      kind: "advisory", reference: adv, applicability: "applies — elder financial exploitation red flags",
      assessed_by: "BSA Officer", controls_updated: ["CG-STR-02"],
    }, as);
    assertEq(r.status, 201, `assessed (${show(r.body)})`);
    const ch = await rowById("regulatory_change", `regchg_${adv}`);
    assert(ch.assessed_at, "assessed");
    assertEq(show(ch.controls_updated), show(["CG-STR-02"]), "controls updated recorded");
    const impl = (await eventsFor(`regulatory_change:regchg_${adv}`)).find((e) => e.code === "regulatory.change_implemented");
    assertEq(impl?.payload.implemented, true, "implemented via updated controls");
  });

  await t.step("an unknown kind is 400", async () => {
    const r = await api("POST", "/bsa/regulatory-changes", { kind: "rumour", reference: `X-${uid()}` }, as);
    assertEq(r.status, 400, `refused (${show(r.body)})`);
  });
});

// =============================================================================
// BSA-14 — escalation
// =============================================================================

flow("bsa_program: an OFAC alert is escalated urgent — acknowledged same day and closed with an action plan; routine gets three days", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  const officer = await actor("cu_admin", ["bsa_officer"]);
  const cp = `achcp_${uid()}`;
  const alert = `alert_${cp}_ofac`;
  let urgent = "";
  let routine = "";

  await t.step("an ACH counterparty hits OFAC: hold + alert", async () => {
    const r = await api("POST", "/bsa/ofac/screens",
      { subject_kind: "ach_counterparty", subject_ref: cp, name: "SDN Trading FZE" }, { key: ops });
    assertEq(r.status, 409, `hold (${show(r.body)})`);
    assert(await rowById("bsa_alert", alert), "alert raised");
  });

  await t.step("operations routes it to the officer as URGENT (1 day) and a related item as ROUTINE (3 days)", async () => {
    const p = await api("POST", "/bsa/escalations",
      { source_ref: alert, severity: "urgent", routed_to: "BSA Officer" }, { key: partner });
    assertEq(p.status, 404, `partner (${show(p.body)})`);
    const u = await api("POST", "/bsa/escalations",
      { source_kind: "bsa_alert", source_ref: alert, severity: "urgent", routed_to: "BSA Officer" }, { key: ops });
    assertEq(u.status, 201, `urgent (${show(u.body)})`);
    urgent = u.body.data.id;
    const r = await api("POST", "/bsa/escalations",
      { source_kind: "bsa_alert", source_ref: alert, severity: "routine", routed_to: "BSA Officer" }, { key: ops });
    assertEq(r.status, 201, `routine (${show(r.body)})`);
    routine = r.body.data.id;
    const ur = await rowById("escalation", urgent);
    const rr = await rowById("escalation", routine);
    spans(ur.routed_at, ur.ack_due_at, 1, "urgent window");
    spans(rr.routed_at, rr.ack_due_at, 3, "routine window");
    assertEq(ur.source_ref, alert, "names its source");
    assert((await codesFor(`escalation:${urgent}`)).includes("escalation.routed"), "routed logged");
    const bad = await api("POST", "/bsa/escalations", { source_ref: alert, severity: "whenever", routed_to: "x" }, { key: ops });
    assertEq(bad.status, 400, `bad severity (${show(bad.body)})`);
  });

  await t.step("an acknowledgement must name who acknowledged", async () => {
    const r = await api("POST", `/bsa/escalations/${urgent}/acknowledge`, {}, { key: officer });
    assertEq(r.status, 400, `refused (${show(r.body)})`);
    assertEq((await rowById("escalation", urgent)).acknowledged_at, null, "unacknowledged");
  });

  await t.step("the officer acknowledges the urgent one and closes it with an ACTION PLAN", async () => {
    const r = await api("POST", `/bsa/escalations/${urgent}/acknowledge`, {
      acknowledged_by: "BSA Officer", disposition: "SAR",
      action_plan: "block counterparty; file SAR within 30 days; 90-day lookback on originating members",
    }, { key: officer });
    assertEq(r.status, 200, `closed (${show(r.body)})`);
    assertEq(r.body.data?.closed, true, "closed");
    const e = await rowById("escalation", urgent);
    assert(e.acknowledged_at && e.closed_at, "acknowledged and closed");
    assertEq(e.disposition, "SAR", "disposition");
    const ev = await eventsFor(`escalation:${urgent}`);
    assertEq(ev.find((x) => x.code === "escalation.acknowledged")?.payload.acknowledged_late, false, "on time");
    assert(ev.some((x) => x.code === "escalation.closed"), "closed logged");
    const plan = ev.find((x) => x.code === "escalation.action_plan.published");
    assert(String(plan?.payload.action_plan ?? "").startsWith("block counterparty"), "the plan is published, not just the disposition");
  });

  await t.step("acknowledging the routine one without a disposition leaves it open", async () => {
    const r = await api("POST", `/bsa/escalations/${routine}/acknowledge`, { acknowledged_by: "BSA Officer" }, { key: officer });
    assertEq(r.status, 200, `acknowledged (${show(r.body)})`);
    assertEq(r.body.data?.closed, false, "not closed");
    const e = await rowById("escalation", routine);
    assert(e.acknowledged_at, "acknowledged");
    assertEq(e.closed_at, null, "still open");
    assert(!(await codesFor(`escalation:${routine}`)).includes("escalation.closed"), "no closed event");
  });

  await t.step("acknowledging an unknown escalation is 404", async () => {
    const r = await api("POST", `/bsa/escalations/esc_nope_${uid()}/acknowledge`, { acknowledged_by: "x" }, { key: officer });
    assertEq(r.status, 404, `unknown (${show(r.body)})`);
  });
});

// =============================================================================
// BSA-12 — CMIR on a cross-border cash shipment
// =============================================================================

flow("bsa_program: $15,000 in currency crosses the border — the CMIR is identified on receipt and filed with its FinCEN reference", async (t) => {
  const partner = await actor("partner");
  const vault = await actor("cu_admin");
  const officer = await actor("cu_admin", ["bsa_officer"]);
  let cmir = "";

  await t.step("the vault receives a cross-border shipment over $10,000: a CMIR is identified", async () => {
    const r = await api("POST", "/cash-ops/shipments", {
      direction: "inbound", amount_cents: 1_500_000, seal_expected: `SEAL-${uid()}`, crosses_border: true,
    }, { key: vault });
    assertEq(r.status, 201, `received (${show(r.body)})`);
    cmir = `cmir_${r.body.data.id}`;
    const c = await rowById("cmir_filing", cmir);
    assert(c, "cmir_filing identified on receipt");
    assertEq(Number(c.amount_cents), 1_500_000, "amount");
    assertEq(c.filed_at, null, "not yet filed");
  });

  await t.step("filing without the FinCEN reference is refused; the partner cannot file", async () => {
    const p = await api("POST", `/bsa/cmir/${cmir}/file`, { filed_by: "x", fincen_ref: "y" }, { key: partner });
    assertEq(p.status, 404, `partner (${show(p.body)})`);
    const r = await api("POST", `/bsa/cmir/${cmir}/file`, { filed_by: "BSA Officer" }, { key: officer });
    assertEq(r.status, 400, `refused (${show(r.body)})`);
    assertEq((await rowById("cmir_filing", cmir)).filed_at, null, "still unfiled");
  });

  await t.step("the officer files FinCEN 105 on time", async () => {
    const ref = `F105-${uid()}`;
    const r = await api("POST", `/bsa/cmir/${cmir}/file`, { filed_by: "BSA Officer", fincen_ref: ref }, { key: officer });
    assertEq(r.status, 200, `filed (${show(r.body)})`);
    const c = await rowById("cmir_filing", cmir);
    assert(c.filed_at, "filed");
    assertEq(c.fincen_ref, ref, "reference retained");
    const ev = await eventsFor(`cmir_filing:${cmir}`);
    assert(ev.some((e) => e.code === "cmir.filing.timer"), "timer logged");
    assertEq(ev.find((e) => e.code === "cmir.filed")?.payload.filed_late, false, "on time");
  });

  await t.step("filing an unknown CMIR is 404", async () => {
    const r = await api("POST", `/bsa/cmir/cmir_nope_${uid()}/file`, { filed_by: "x", fincen_ref: "y" }, { key: officer });
    assertEq(r.status, 404, `unknown (${show(r.body)})`);
  });
});

// =============================================================================
// BSA-07 — SAR timers, continuing activity, confidentiality
// =============================================================================

flow("bsa_program: an OFAC alert becomes a case — SAR clocks start, a disclosure request is declined on the record, a continuing filing needs its reference", async (t) => {
  const ops = await actor("pynthia_ops");
  const investigator = await actor("cu_admin", ["bsa_investigator"]);
  const officer = await actor("cu_admin", ["bsa_officer"]);
  const partner = await actor("partner");
  const cp = `wirebene_${uid()}`;
  let caseId = "";

  await t.step("a wire beneficiary hits OFAC and the investigator escalates the alert to a case", async () => {
    const s = await api("POST", "/bsa/ofac/screens",
      { subject_kind: "wire_beneficiary", subject_ref: cp, name: "SDN Shipping Ltd" }, { key: ops });
    assertEq(s.status, 409, `hold (${show(s.body)})`);
    const r = await api("POST", `/bsa/alerts/alert_${cp}_ofac/triage`,
      { outcome: "escalated", note: "beneficiary potential SDN match" }, { key: investigator });
    assertEq(r.status, 200, `escalated (${show(r.body)})`);
    caseId = String(r.body.case?.id);
    assert(caseId.startsWith("case_"), `case opened (${show(r.body)})`);
  });

  await t.step("the SAR clocks start: 30-day filing and 120-day continuing timers", async () => {
    const p = await api("POST", `/bsa/sar/${caseId}/lifecycle`, { stage: "timer" }, { key: partner });
    assertEq(p.status, 404, `partner (${show(p.body)})`);
    const r = await api("POST", `/bsa/sar/${caseId}/lifecycle`, { stage: "timer" }, { key: officer });
    assertEq(r.status, 200, `timers (${show(r.body)})`);
    const ev = await eventsFor(`case:${caseId}`);
    const t30 = ev.find((e) => e.code === "sar.filing.timer");
    const t120 = ev.find((e) => e.code === "sar.continuing_timer");
    assert(t30 && t120, `both timers logged (${ev.map((e) => e.code)})`);
    spans(new Date().toISOString(), t30!.payload.due_at, 30, "filing timer");
    spans(new Date().toISOString(), t120!.payload.due_at, 120, "continuing timer");
  });

  await t.step("the subject's attorney asks whether a SAR exists: logged and DECLINED", async () => {
    const no = await api("POST", `/bsa/sar/${caseId}/lifecycle`, { stage: "disclosure_request" }, { key: officer });
    assertEq(no.status, 400, `requester required (${show(no.body)})`);
    const r = await api("POST", `/bsa/sar/${caseId}/lifecycle`,
      { stage: "disclosure_request", requester: "subject's attorney" }, { key: officer });
    assertEq(r.status, 200, `declined (${show(r.body)})`);
    assertEq(r.body.data?.declined, true, "declined");
    const ev = await eventsFor(`case:${caseId}`);
    assert(ev.some((e) => e.code === "sar.disclosure_request.received"), "request logged");
    const dec = ev.find((e) => e.code === "sar.disclosure.declined");
    assert(String(dec?.payload.basis ?? "").includes("1020.320(e)"), "the refusal cites its basis");
  });

  await t.step("a continuing-activity filing needs its FinCEN reference", async () => {
    const no = await api("POST", `/bsa/sar/${caseId}/lifecycle`, { stage: "continuing", filed_by: "BSA Officer" }, { key: officer });
    assertEq(no.status, 400, `refused (${show(no.body)})`);
    const ok = await api("POST", `/bsa/sar/${caseId}/lifecycle`,
      { stage: "continuing", filed_by: "BSA Officer", fincen_ref: `SAR-${uid()}` }, { key: officer });
    assertEq(ok.status, 200, `filed (${show(ok.body)})`);
    assert((await codesFor(`case:${caseId}`)).includes("sar.continuing.filed"), "continuing filing logged");
    const bad = await api("POST", `/bsa/sar/${caseId}/lifecycle`, { stage: "shred" }, { key: officer });
    assertEq(bad.status, 400, `unknown stage (${show(bad.body)})`);
  });

  await t.step("SAR lifecycle on a case that does not exist is 404, not a filing record", async () => {
    // DEFECT: postSarLifecycle never loads the case (bsa_program.ts ~L639-689) — timers, continuing filings and disclosure refusals are recorded against any caseId string
    const ghost = `case_ghost_${uid()}`;
    const r = await api("POST", `/bsa/sar/${ghost}/lifecycle`,
      { stage: "continuing", filed_by: "BSA Officer", fincen_ref: "SAR-0" }, { key: officer });
    assertEq(r.status, 404, `unknown case (${r.status}: ${show(r.body)})`);
    assertEq((await codesFor(`case:${ghost}`)).length, 0, "no filing evidence for a case that does not exist");
  });
});

// =============================================================================
// BSA-08 — annual CTR exemption review
// =============================================================================

flow("bsa_program: the annual review of an exempt business's CTR exemption is recorded with its re-verification", async (t) => {
  const partner = await actor("partner");
  const compliance = await actor("cu_admin", ["bsa_compliance"]);
  let biz = "";

  await t.step("the partner onboards a cash-heavy business", async () => {
    const r = await api("POST", "/entities", { type: "business", name: `Lakeside Grocers ${uid()}`, tin: "36-4455667" }, { key: partner });
    assertEq(r.status, 201, `business (${show(r.body)})`);
    biz = String(r.body.id);
  });

  await t.step("compliance reviews the exemption: retained, eligibility re-verified, on the record", async () => {
    const p = await api("POST", "/bsa/ctr/exemptions/review", { entity_ref: biz, reviewed_by: "x" }, { key: partner });
    assertEq(p.status, 404, `partner (${show(p.body)})`);
    const no = await api("POST", "/bsa/ctr/exemptions/review", { entity_ref: biz }, { key: compliance });
    assertEq(no.status, 400, `reviewer required (${show(no.body)})`);
    const r = await api("POST", "/bsa/ctr/exemptions/review",
      { entity_ref: biz, decision: "retained", reviewed_by: "BSA Compliance", eligibility_reverified: true }, { key: compliance });
    assertEq(r.status, 201, `reviewed (${show(r.body)})`);
    const ev = (await eventsFor(`entity:${biz}`)).find((e) => e.code === "ctr.exemption.reviewed");
    assert(ev, "ctr.exemption.reviewed logged on the member");
    assertEq(ev!.payload.decision, "retained", "decision");
    assertEq(ev!.payload.eligibility_reverified, true, "re-verification recorded");
    assertEq(ev!.payload.reviewed_by, "BSA Compliance", "reviewer");
    assertEq(ev!.provenance, "demo", "demo evidence");
  });
});
