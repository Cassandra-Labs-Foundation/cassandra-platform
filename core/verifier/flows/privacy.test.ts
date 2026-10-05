// Privacy flows (PR-01..PR-18): Pynthia's privacy operations staff run the
// GLBA notice lifecycle, opt-outs, state privacy rights, web tracking consent,
// analytics releases, biometric KYC, children's data, FCRA furnishing
// disputes, disclosures and member-data access — and an integrating fintech
// connects a third party to a member's data under a scoped token. Ported from
// the user-observable behaviour of the privacy.ts unit stubs (see
// ledger/privacy.md), plus the PR-03/PR-04/PR-15 gates the stubs never drove.
//
// Every privacy route but one is staff-only: the self-gated ones answer a
// partner with 404 (the route does not exist for it), the x-actors ones with
// 403. POST /privacy/connections is the partner surface.
//
// Fixtures: every subject is a fresh member created by the partner, so every
// id the handlers derive (`ppref_<entity>_<channel>`, `psreq_<entity>_<right>`
// …) is run-unique. Two sweeps (opt-out propagation, biometric purge) are
// instance-wide by design; the flows only assert on their own rows, and age
// their own row past its deadline with a service-role update (the clock the
// sweep reads) rather than waiting 30 days.
import { actor, type Any, api, assert, assertEq, core, flow, personaName, uid } from "./helpers.ts";

const DAY = 86_400_000;
const body = (r: { body: Any }) => JSON.stringify(r.body).slice(0, 300);

/** a fresh member, created by the partner as its fintech would */
async function member(partner: string): Promise<string> {
  const e = await api("POST", "/entities", {
    type: "person", name: personaName(), date_of_birth: "1987-03-14",
    address: "12 Elm St, Springfield, IL 62701",
  }, { key: partner });
  assertEq(e.status, 201, `create entity (${body(e)})`);
  return String(e.body.id);
}

async function row(table: string, id: string): Promise<Any> {
  const r = await core().from(table).select("*").eq("id", id).maybeSingle();
  assert(!r.error, `${table} read: ${r.error?.message}`);
  return r.data;
}

async function eventsFor(resourceType: string, id: string): Promise<Any[]> {
  const r = await core().from("event").select("id, code, payload, provenance")
    .eq("resource_id", `${resourceType}:${id}`);
  assert(!r.error, `event read: ${r.error?.message}`);
  return r.data ?? [];
}
const codesOf = (evs: Any[]) => evs.map((e) => String(e.code));

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

// ------------------------------------------------------------- PR-01 / PR-11

flow("privacy: GLBA notice published → E-SIGN gate refuses undemonstrated consent → member-requested copy delivered electronically", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  const version = `flow_${uid()}`;
  const noticeId = `pnotice_${version}`;
  let entity = "";

  await t.step("a partner cannot reach the privacy staff routes", async () => {
    entity = await member(partner);
    const n = await api("POST", "/privacy/notices", { version, template_ref: "tpl" }, { key: partner });
    assertEq(n.status, 404, `partner publishing a notice (${body(n)})`);
    const p = await api("POST", "/privacy/preferences", {
      entity_ref: entity, channel: "marketing", opted_out: true, source: "member_request",
    }, { key: partner });
    assertEq(p.status, 404, `partner setting a preference (${body(p)})`);
    assertEq(await row("privacy_notice", noticeId), null, "nothing was published");
    assertEq(await row("privacy_preference", `ppref_${entity}_marketing`), null, "nothing was recorded");
  });

  await t.step("ops publishes a materially-changed notice: row + published/website/revised events", async () => {
    const bad = await api("POST", "/privacy/notices", { version }, { key: ops });
    assertEq(bad.status, 400, `notice without a template (${body(bad)})`);
    const r = await api("POST", "/privacy/notices", {
      version, template_ref: `tpl_${version}`, material_change: true,
    }, { key: ops });
    assertEq(r.status, 201, `publish (${body(r)})`);
    assertEq(r.body.data.id, noticeId, "notice id");
    const n = await row("privacy_notice", noticeId);
    assertEq(n?.template_ref, `tpl_${version}`, "template recorded");
    assertEq(n?.material_change, true, "material change recorded");
    assert(n?.published_to_website_at, "website publication stamped");
    assertEq(n?.provenance, "demo", "test-actor evidence is labelled demo");
    const c = codesOf(await eventsFor("privacy_notice", noticeId));
    for (const code of ["privacy.notice_template.published", "privacy.website_notice.updated", "privacy.notice.revised"]) {
      assert(c.includes(code), `${code} emitted (got ${c})`);
    }
  });

  await t.step("E-SIGN delivery with NO consent is refused and leaves no delivery row", async () => {
    const r = await api("POST", `/privacy/notices/${noticeId}/deliver`, {
      entity_ref: entity, reason: "annual", channel: "esign",
    }, { key: ops });
    assertEq(r.status, 409, `esign without consent (${body(r)})`);
    assertEq(r.body.type, "esign_consent_missing", "typed refusal");
    assertEq(await row("privacy_notice_delivery", `pdeliv_${noticeId}_${entity}_annual`), null, "no delivery recorded");
  });

  await t.step("a checkbox that did not DEMONSTRATE access is not consent: delivery still refused", async () => {
    const c = await api("POST", "/privacy/esign-consents", { entity_ref: entity, demonstrated_access: false }, { key: ops });
    assertEq(c.status, 201, `consent capture (${body(c)})`);
    assertEq(c.body.data.captured, false, "not captured");
    const consent = await row("esign_consent", `esign_${entity}`);
    assertEq(consent?.captured_at, null, "captured_at stays null");
    assertEq(consent?.demonstrated_access, false, "access not demonstrated");
    const ev = codesOf(await eventsFor("esign_consent", `esign_${entity}`));
    assert(ev.includes("privacy.esign_consent.incomplete"), `incomplete recorded (got ${ev})`);
    assert(!ev.includes("privacy.esign_consent.recorded"), "no 'recorded' event for a checkbox");
    const r = await api("POST", `/privacy/notices/${noticeId}/deliver`, {
      entity_ref: entity, reason: "annual", channel: "esign", esign_consent_id: `esign_${entity}`,
    }, { key: ops });
    assertEq(r.status, 409, `esign on undemonstrated consent (${body(r)})`);
    assertEq(r.body.type, "esign_consent_invalid", "typed refusal");
    assertEq(await row("privacy_notice_delivery", `pdeliv_${noticeId}_${entity}_annual`), null, "no delivery recorded");
  });

  await t.step("demonstrated consent permits electronic delivery of a requested copy, due in 30 days", async () => {
    const c = await api("POST", "/privacy/esign-consents", { entity_ref: entity, demonstrated_access: true }, { key: ops });
    assertEq(c.status, 201, `consent capture (${body(c)})`);
    assertEq(c.body.data.captured, true, "captured");
    assert((await row("esign_consent", `esign_${entity}`))?.captured_at, "captured_at stamped");
    assert(codesOf(await eventsFor("esign_consent", `esign_${entity}`)).includes("privacy.esign_consent.recorded"), "consent recorded");
    const r = await api("POST", `/privacy/notices/${noticeId}/deliver`, {
      entity_ref: entity, reason: "member_request", channel: "esign", esign_consent_id: `esign_${entity}`,
    }, { key: ops });
    assertEq(r.status, 201, `deliver (${body(r)})`);
    const id = `pdeliv_${noticeId}_${entity}_member_request`;
    const d = await row("privacy_notice_delivery", id);
    assert(d?.delivered_at, "the delivery row records it, not only the event");
    assertEq(d?.esign_consent_id, `esign_${entity}`, "consent the delivery relied on");
    assertEq(daysBetween(d.delivered_at, d.due_at), 30, "member-request copy due in 30 days");
    const ev = codesOf(await eventsFor("privacy_notice_delivery", id));
    assert(ev.includes("privacy.notice.delivered"), "notice.delivered");
    assert(ev.includes("privacy.notice_copy.delivered"), "notice_copy.delivered");
  });

  await t.step("an annual notice by mail needs no consent and runs on the 365-day cycle", async () => {
    const bad = await api("POST", `/privacy/notices/${noticeId}/deliver`, {
      entity_ref: entity, reason: "whenever", channel: "mail",
    }, { key: ops });
    assertEq(bad.status, 400, `unknown reason (${body(bad)})`);
    const r = await api("POST", `/privacy/notices/${noticeId}/deliver`, {
      entity_ref: entity, reason: "annual", channel: "mail",
    }, { key: ops });
    assertEq(r.status, 201, `deliver (${body(r)})`);
    const d = await row("privacy_notice_delivery", `pdeliv_${noticeId}_${entity}_annual`);
    assertEq(d?.channel, "mail", "channel");
    assertEq(daysBetween(d.delivered_at, d.due_at), 365, "annual cycle");
    const ev = codesOf(await eventsFor("privacy_notice_delivery", d.id));
    assert(!ev.includes("privacy.notice_copy.delivered"), "an annual notice is not a requested copy");
  });
});

// --------------------------------------------------------------- PR-02

flow("privacy: member opts out of sharing → standing state → propagation (late recorded) → Nevada regime → opt-out cleared", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  let entity = "";
  let prefId = "";

  await t.step("opt out of non-affiliate sharing: a standing state with a 30-day propagation deadline", async () => {
    entity = await member(partner);
    prefId = `ppref_${entity}_nonaffiliate_sharing`;
    const bad = await api("POST", "/privacy/preferences", {
      entity_ref: entity, channel: "nonaffiliate_sharing", source: "member_request",
    }, { key: ops });
    assertEq(bad.status, 400, `opt-out with no explicit opted_out (${body(bad)})`);
    const r = await api("POST", "/privacy/preferences", {
      entity_ref: entity, channel: "nonaffiliate_sharing", opted_out: true,
      source: "member_request", entity_jurisdiction: "CA",
    }, { key: ops });
    assertEq(r.status, 201, `opt out (${body(r)})`);
    const p = await row("privacy_preference", prefId);
    assertEq(p?.opted_out, true, "opted out");
    assertEq(p?.propagated_at, null, "captured is not propagated");
    assertEq(p?.entity_jurisdiction, "CA", "jurisdiction kept");
    assertEq(daysBetween(p.effective_at, p.propagation_due_at), 30, "GLBA 30-day propagation deadline");
    const ev = codesOf(await eventsFor("privacy_preference", prefId));
    assert(ev.includes("privacy.optout.received"), "optout.received");
    assert(!ev.includes("privacy.nv_optout_enforced"), "a GLBA opt-out is not the Nevada regime");
  });

  await t.step("propagation naming NO systems is refused and propagates nothing", async () => {
    const r = await api("POST", "/privacy/preferences/propagate", { systems: [] }, { key: ops });
    assertEq(r.status, 400, `empty propagation (${body(r)})`);
    assertEq((await row("privacy_preference", prefId))?.propagated_at, null, "still unpropagated");
  });

  await t.step("a sweep after the deadline propagates it and records that it was LATE", async () => {
    const age = await core().from("privacy_preference")
      .update({ propagation_due_at: new Date(Date.now() - 2 * DAY).toISOString() }).eq("id", prefId);
    assert(!age.error, `age the deadline: ${age.error?.message}`);
    const r = await api("POST", "/privacy/preferences/propagate", { systems: ["core", "marketing_feed"] }, { key: ops });
    assertEq(r.status, 200, `propagate (${body(r)})`);
    assert(r.body.data.propagated >= 1 && r.body.data.late >= 1, `sweep counts (${body(r)})`);
    assert((await row("privacy_preference", prefId))?.propagated_at, "propagated_at stamped");
    const ev = (await eventsFor("privacy_preference", prefId)).find((e) => e.code === "privacy.optout_propagated");
    assert(ev, "optout_propagated emitted");
    assertEq(ev.payload.propagated_late, true, "lateness recorded");
    assertEq(JSON.stringify(ev.payload.systems), JSON.stringify(["core", "marketing_feed"]), "systems named");
  });

  await t.step("a Nevada sale opt-out is its own regime", async () => {
    const r = await api("POST", "/privacy/preferences", {
      entity_ref: entity, channel: "nevada_sale", opted_out: true, source: "member_request",
    }, { key: ops });
    assertEq(r.status, 201, `nv opt-out (${body(r)})`);
    const ev = codesOf(await eventsFor("privacy_preference", `ppref_${entity}_nevada_sale`));
    assert(ev.includes("privacy.nv_optout_enforced"), `nv_optout_enforced (got ${ev})`);
  });

  await t.step("CLEARING an opt-out is recorded as its own state change", async () => {
    const set = await api("POST", "/privacy/preferences", {
      entity_ref: entity, channel: "marketing", opted_out: false, source: "member_request",
    }, { key: ops });
    assertEq(set.status, 201, `clear (${body(set)})`);
    const id = `ppref_${entity}_marketing`;
    assertEq((await row("privacy_preference", id))?.opted_out, false, "standing state: not opted out");
    const ev = codesOf(await eventsFor("privacy_preference", id));
    assert(ev.includes("privacy.optout.cleared"), "optout.cleared");
    assert(!ev.includes("privacy.optout.received"), "no opt-out was received");
  });
});

// --------------------------------------------------------------- PR-12

flow("privacy: state rights — unverified fulfilment refused → verified access fulfilled; denial needs a basis; opt-out right sets the standing state", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  let entity = "";

  await t.step("a CA access request is logged with the strictest (45-day) deadline", async () => {
    entity = await member(partner);
    const bad = await api("POST", "/privacy/state-requests", { entity_ref: entity, state: "CA", right_requested: "sell_everything" }, { key: ops });
    assertEq(bad.status, 400, `unknown right (${body(bad)})`);
    const received = new Date(Date.now() - 3 * DAY).toISOString();
    const r = await api("POST", "/privacy/state-requests", {
      entity_ref: entity, state: "CA", right_requested: "access", received_at: received,
    }, { key: ops });
    assertEq(r.status, 201, `log request (${body(r)})`);
    const q = await row("privacy_state_request", `psreq_${entity}_access`);
    assertEq(daysBetween(q.received_at, q.due_at), 45, "universal floor = strictest deadline");
    assertEq(q.fulfilled_at, null, "open");
    const ev = codesOf(await eventsFor("privacy_state_request", q.id));
    assert(ev.includes("privacy.state_request.received") && ev.includes("privacy.state_request_due_at"), `events (got ${ev})`);
  });

  await t.step("fulfilling an UNVERIFIED request is refused — that IS the disclosure", async () => {
    const id = `psreq_${entity}_access`;
    const r = await api("POST", `/privacy/state-requests/${id}/fulfil`, { verified: false, outcome: "fulfilled" }, { key: ops });
    assertEq(r.status, 409, `unverified fulfil (${body(r)})`);
    assertEq(r.body.type, "state_request_unverified", "typed refusal");
    const q = await row("privacy_state_request", id);
    assertEq(q.fulfilled_at, null, "not fulfilled");
    assertEq(q.verified_at, null, "not verified");
    const missing = await api("POST", `/privacy/state-requests/psreq_${uid()}/fulfil`, { verified: true }, { key: ops });
    assertEq(missing.status, 404, `unknown request (${body(missing)})`);
  });

  await t.step("the verified request is fulfilled on time", async () => {
    const id = `psreq_${entity}_access`;
    const r = await api("POST", `/privacy/state-requests/${id}/fulfil`, { verified: true, outcome: "fulfilled" }, { key: ops });
    assertEq(r.status, 200, `fulfil (${body(r)})`);
    const q = await row("privacy_state_request", id);
    assert(q.verified_at && q.fulfilled_at, "verified + fulfilled stamped");
    assertEq(q.outcome, "fulfilled", "outcome");
    const ev = (await eventsFor("privacy_state_request", id)).find((e) => e.code === "privacy.state_request_fulfilled");
    assertEq(ev?.payload?.fulfilled_late, false, "on time");
  });

  await t.step("a delete request denied without a basis is refused; with a basis it is recorded", async () => {
    const lg = await api("POST", "/privacy/state-requests", { entity_ref: entity, state: "CO", right_requested: "delete" }, { key: ops });
    assertEq(lg.status, 201, `log delete (${body(lg)})`);
    const id = `psreq_${entity}_delete`;
    const r = await api("POST", `/privacy/state-requests/${id}/fulfil`, { verified: true, outcome: "denied" }, { key: ops });
    assertEq(r.status, 400, `denial without basis (${body(r)})`);
    assertEq((await row("privacy_state_request", id)).fulfilled_at, null, "nothing closed");
    const ok = await api("POST", `/privacy/state-requests/${id}/fulfil`, {
      verified: true, outcome: "denied", denial_basis: "BSA record retention (31 CFR 1010.430)",
    }, { key: ops });
    assertEq(ok.status, 200, `denial with basis (${body(ok)})`);
    const q = await row("privacy_state_request", id);
    assertEq(q.outcome, "denied", "denied");
    assert(String(q.denial_basis).includes("1010.430"), "basis kept");
  });

  await t.step("an OPT-OUT right sets the standing state, not just a ticket", async () => {
    const r = await api("POST", "/privacy/state-requests", { entity_ref: entity, state: "NV", right_requested: "opt_out" }, { key: ops });
    assertEq(r.status, 201, `log opt-out right (${body(r)})`);
    const p = await row("privacy_preference", `ppref_${entity}_nonaffiliate_sharing`);
    assertEq(p?.opted_out, true, "opted out");
    assertEq(p?.source, "state_request", "source is the state request");
    assertEq(p?.propagated_at, null, "awaiting propagation like any opt-out");
  });
});

// --------------------------------------------------------------- PR-14

flow("privacy: web tracking — tags reviewed → consent gates by approval AND category → GPC overrides the banner", async (t) => {
  const ops = await actor("pynthia_ops");
  const tag = uid().replace(/[^a-z0-9]/g, "");
  const approved = `wtag_flowanalytics${tag}`;
  const rejected = `wtag_flowadnet${tag}`;
  const pending = `wtag_flowpixel${tag}`;

  await t.step("a decided tag needs a named reviewer; reviews are recorded with their decision", async () => {
    const bad = await api("POST", "/privacy/web/tags", { vendor: `Flow Analytics ${tag}`, category: "analytics", decision: "approved" }, { key: ops });
    assertEq(bad.status, 400, `approval with no reviewer (${body(bad)})`);
    assertEq(await row("web_tag", approved), null, "nothing recorded");
    const a = await api("POST", "/privacy/web/tags", { vendor: `Flow Analytics ${tag}`, category: "analytics", decision: "approved", reviewed_by: "privacy_officer" }, { key: ops });
    assertEq(a.status, 201, `approve (${body(a)})`);
    const r = await api("POST", "/privacy/web/tags", { vendor: `Flow AdNet ${tag}`, category: "advertising", decision: "rejected", reviewed_by: "privacy_officer" }, { key: ops });
    assertEq(r.status, 201, `reject (${body(r)})`);
    const p = await api("POST", "/privacy/web/tags", { vendor: `Flow Pixel ${tag}`, category: "analytics" }, { key: ops });
    assertEq(p.status, 201, `pending (${body(p)})`);
    assertEq((await row("web_tag", approved))?.reviewed_by, "privacy_officer", "reviewer recorded");
    assertEq((await row("web_tag", rejected))?.decision, "rejected", "rejection recorded");
    assertEq((await row("web_tag", pending))?.reviewed_at, null, "pending has no review date");
    assert(codesOf(await eventsFor("web_tag", rejected)).includes("web.tag.rejected"), "web.tag.rejected");
    assert(codesOf(await eventsFor("web_tag", pending)).includes("web.tag_review.requested"), "review requested");
  });

  await t.step("consent to everything: only the approved tag may fire", async () => {
    const s = `sess_${uid()}`;
    const r = await api("POST", "/privacy/web/consent", { session_ref: s, categories: { analytics: true, advertising: true } }, { key: ops });
    assertEq(r.status, 201, `consent (${body(r)})`);
    const c = await row("web_consent", `wconsent_${s}`);
    const gated = c.tags_gated as string[];
    assert(!gated.includes(approved), "the approved, consented tag fires");
    assert(gated.includes(rejected), "the rejected tag is gated even with consent");
    assert(gated.includes(pending), "a never-reviewed tag is gated");
    assertEq(c.gpc_signal, false, "no GPC");
  });

  await t.step("a GPC signal OVERRIDES the banner: nothing optional fires", async () => {
    const s = `sess_${uid()}`;
    const r = await api("POST", "/privacy/web/consent", {
      session_ref: s, gpc_signal: true, categories: { analytics: true, advertising: true, functional: true },
    }, { key: ops });
    assertEq(r.status, 201, `consent (${body(r)})`);
    const c = await row("web_consent", `wconsent_${s}`);
    assertEq(c.categories.advertising, false, "a banner click must not re-enable what GPC turned off");
    assertEq(c.categories.analytics, false, "analytics off");
    assertEq(c.categories.functional, false, "functional off");
    assertEq(c.categories.essential, true, "essential stays on");
    assert((c.tags_gated as string[]).includes(approved), "even the approved analytics tag is gated");
    const ev = (await eventsFor("web_consent", c.id)).find((e) => e.code === "web.gpc_signal");
    assertEq(ev?.payload?.honoured, true, "GPC honoured on the record");
  });
});

// --------------------------------------------------------------- PR-13

flow("privacy: analytics release — over the re-id threshold refused; k-anonymity needs k; raw never auto-approved; safe aggregate approved", async (t) => {
  const ops = await actor("pynthia_ops");
  const ds = (purpose: string) => `ads_${purpose.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24)}`;

  await t.step("a dataset over the re-identification threshold is NOT released", async () => {
    const purpose = `churn ${uid()}`;
    const r = await api("POST", "/privacy/analytics/datasets", {
      purpose, requested_by: "analyst_1", method: "aggregation", reid_risk_bp: 900, risk_threshold_bp: 500,
    }, { key: ops });
    assertEq(r.status, 409, `over threshold (${body(r)})`);
    assertEq(r.body.type, "reid_risk_too_high", "typed refusal");
    const d = await row("analytics_dataset", ds(purpose));
    assertEq(d?.risk_breached, true, "breach recorded");
    assertEq(d?.approved_at, null, "not approved");
    const ev = codesOf(await eventsFor("analytics_dataset", ds(purpose)));
    assert(ev.includes("analytics.threshold.breached"), "threshold.breached");
    assert(!ev.includes("analytics.dataset.approved"), "not approved");
  });

  await t.step("k-anonymity with no k is refused", async () => {
    const purpose = `segments ${uid()}`;
    const r = await api("POST", "/privacy/analytics/datasets", { purpose, requested_by: "analyst_1", method: "k_anonymity" }, { key: ops });
    assertEq(r.status, 400, `no k (${body(r)})`);
    assertEq(await row("analytics_dataset", ds(purpose)), null, "nothing requested on the record");
  });

  await t.step("a RAW dataset is never auto-approved, even at negligible risk", async () => {
    const purpose = `raw ${uid()}`;
    const r = await api("POST", "/privacy/analytics/datasets", {
      purpose, requested_by: "analyst_1", method: "raw", reid_risk_bp: 1, risk_threshold_bp: 500,
    }, { key: ops });
    assertEq(r.status, 201, `raw (${body(r)})`);
    assertEq(r.body.data.approved, false, "not approved");
    assertEq((await row("analytics_dataset", ds(purpose)))?.approved_at, null, "approved_at null");
    assert(!codesOf(await eventsFor("analytics_dataset", ds(purpose))).includes("analytics.dataset.approved"), "no approval event");
  });

  await t.step("a k-anonymised dataset under the threshold is approved", async () => {
    const purpose = `kanon ${uid()}`;
    const r = await api("POST", "/privacy/analytics/datasets", {
      purpose, requested_by: "analyst_1", method: "k_anonymity", k_value: 10, reid_risk_bp: 100, risk_threshold_bp: 500,
    }, { key: ops });
    assertEq(r.status, 201, `k-anon (${body(r)})`);
    const d = await row("analytics_dataset", ds(purpose));
    assertEq(d?.k_value, 10, "k recorded");
    assertEq(d?.risk_breached, false, "under threshold");
    assert(d?.approved_at, "approved");
    assert(codesOf(await eventsFor("analytics_dataset", d.id)).includes("analytics.dataset.approved"), "approval event");
  });
});

// --------------------------------------------------------------- PR-16

flow("privacy: biometric KYC — no consent refused → verified with a non-biometric alternative on offer → purged at retention expiry", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  let entity = "";
  let bioId = "";

  await t.step("capturing biometrics with NO consent is refused outright", async () => {
    entity = await member(partner);
    bioId = `bio_${entity}`;
    const r = await api("POST", "/privacy/biometrics", { entity_ref: entity }, { key: ops });
    assertEq(r.status, 409, `no consent (${body(r)})`);
    assertEq(r.body.type, "biometric_consent_required", "typed refusal");
    assertEq(await row("biometric_verification", bioId), null, "nothing captured");
  });

  await t.step("with written consent: verified, alternative path on offer, 30-day purge clock", async () => {
    const r = await api("POST", "/privacy/biometrics", { entity_ref: entity, consent_id: `bioconsent_${uid()}`, outcome: "verified" }, { key: ops });
    assertEq(r.status, 201, `capture (${body(r)})`);
    const b = await row("biometric_verification", bioId);
    assertEq(b?.outcome, "verified", "verified");
    assertEq(b?.alt_path_available, true, "non-biometric alternative available");
    assertEq(b?.purged_at, null, "not purged");
    assertEq(daysBetween(b.completed_at, b.purge_due_at), 30, "30-day purge deadline");
    const v = await row("verification", `ver_bio_${entity}`);
    assertEq(v?.entity_id, entity, "a verification lands on the member's record");
    assertEq(v?.match_status, "match", "match");
    const ev = codesOf(await eventsFor("biometric_verification", bioId));
    for (const code of ["verification.biometric.started", "verification.biometric.completed", "verification.biometric.purge.due_at"]) {
      assert(ev.includes(code), `${code} (got ${ev})`);
    }
  });

  await t.step("a purge sweep before the deadline leaves it; after the deadline it is purged", async () => {
    const early = await api("POST", "/privacy/biometrics/purge", {}, { key: ops });
    assertEq(early.status, 200, `sweep (${body(early)})`);
    assertEq((await row("biometric_verification", bioId))?.purged_at, null, "not yet due");
    const age = await core().from("biometric_verification")
      .update({ purge_due_at: new Date(Date.now() - DAY).toISOString() }).eq("id", bioId);
    assert(!age.error, `age the deadline: ${age.error?.message}`);
    const r = await api("POST", "/privacy/biometrics/purge", {}, { key: ops });
    assertEq(r.status, 200, `sweep (${body(r)})`);
    assert(r.body.data.purged >= 1, `purged count (${body(r)})`);
    assert((await row("biometric_verification", bioId))?.purged_at, "purged_at stamped");
    assert(codesOf(await eventsFor("biometric_verification", bioId)).includes("verification.biometric_purged"), "purge recorded");
  });
});

// --------------------------------------------------------------- PR-17

flow("privacy: children's data — the age gate blocks; minor data found after collection is detected then deleted", async (t) => {
  const ops = await actor("pynthia_ops");
  const blocked = `subj_${uid()}`;
  const found = `subj_${uid()}`;

  await t.step("an under-13 applicant is blocked at the gate (no detection, no deletion obligation)", async () => {
    const bad = await api("POST", "/privacy/minors", { age_asserted: 11 }, { key: ops });
    assertEq(bad.status, 400, `no subject (${body(bad)})`);
    const r = await api("POST", "/privacy/minors", { subject_ref: blocked, age_asserted: 12 }, { key: ops });
    assertEq(r.status, 201, `gate (${body(r)})`);
    assertEq(r.body.data.kind, "age_gate_blocked", "an asserted age under 13 is a gate block");
    const id = `minor_${blocked}_age_gate_blocked`;
    assertEq((await row("minor_data_event", id))?.age_asserted, 12, "age kept");
    const ev = codesOf(await eventsFor("minor_data_event", id));
    assert(ev.includes("privacy.age_gate.blocked"), "age_gate.blocked");
    assert(!ev.includes("privacy.minor_data.detected"), "not a detection");
  });

  await t.step("minor data detected after collection, then deleted", async () => {
    const d = await api("POST", "/privacy/minors", { kind: "minor_data_detected", subject_ref: found, age_asserted: 10 }, { key: ops });
    assertEq(d.status, 201, `detect (${body(d)})`);
    assert(codesOf(await eventsFor("minor_data_event", `minor_${found}_minor_data_detected`)).includes("privacy.minor_data.detected"), "detected");
    const del = await api("POST", "/privacy/minors", { kind: "deleted", subject_ref: found }, { key: ops });
    assertEq(del.status, 201, `delete (${body(del)})`);
    const id = `minor_${found}_deleted`;
    assert((await row("minor_data_event", id))?.deleted_at, "deleted_at stamped");
    assert(codesOf(await eventsFor("minor_data_event", id)).includes("privacy.minor_data_deleted"), "deletion recorded");
  });
});

// --------------------------------------------------------------- PR-05

flow("privacy: FCRA furnishing dispute — a DISPUTE with no money; NCOA mismatch raises a red flag; a correction only reaches the bureaus when propagated", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  let entity = "";

  await t.step("an address dispute with an NCOA mismatch: red flag, address row, dispute register entry", async () => {
    entity = await member(partner);
    const bad = await api("POST", "/privacy/furnishing-disputes", { entity_ref: entity }, { key: ops });
    assertEq(bad.status, 400, `no field (${body(bad)})`);
    const r = await api("POST", "/privacy/furnishing-disputes", {
      entity_ref: entity, field: "address", disputed_value: "12 Elm St",
      ncoa_candidate: "9 New Rd, Springfield, IL 62702", ncoa_mismatch: true, redflag: true,
    }, { key: ops });
    assertEq(r.status, 201, `dispute (${body(r)})`);
    const id = `fdisp_${entity}_address`;
    const d = await row("furnishing_dispute", id);
    assertEq(d?.address_ncoa_mismatch, true, "mismatch verdict kept");
    assertEq(d?.redflag_raised, true, "red flag raised");
    assertEq(daysBetween(d.received_at, d.due_at), 30, "FCRA 30-day investigation clock");
    assertEq((await row("address", `addr_${entity}`))?.ncoa_candidate, "9 New Rd, Springfield, IL 62702", "candidate is a row");
    const reg = await row("dispute", `disp_${id}`);
    assertEq(reg?.kind, "data_accuracy", "same register as Reg E disputes, distinguished by kind");
    assertEq(reg?.amount_cents, null, "a data-accuracy dispute has no money in it");
    assertEq(reg?.provisional_credit_due_at, null, "and no Reg E clock");
    const ev = codesOf(await eventsFor("furnishing_dispute", id));
    for (const code of ["furnishing.dispute.received", "address.ncoa_mismatch.detected", "redflag.detected", "furnishing.dispute_due_at"]) {
      assert(ev.includes(code), `${code} (got ${ev})`);
    }
  });

  await t.step("a correction applied but NOT propagated is not propagated (the deadline is set)", async () => {
    const id = `fdisp_${entity}_address`;
    const bad = await api("POST", `/privacy/furnishing-disputes/${id}/correct`, {}, { key: ops });
    assertEq(bad.status, 400, `no corrected value (${body(bad)})`);
    const r = await api("POST", `/privacy/furnishing-disputes/${id}/correct`, { corrected_value: "9 New Rd" }, { key: ops });
    assertEq(r.status, 200, `correct (${body(r)})`);
    assertEq(r.body.data.propagated, false, "not propagated");
    const d = await row("furnishing_dispute", id);
    assert(d.correction_applied_at, "applied");
    assertEq(d.propagated_at, null, "the bureaus never see an unpropagated correction");
    assertEq(daysBetween(d.correction_applied_at, d.propagation_due_at), 5, "5-day propagation deadline");
    const ev = codesOf(await eventsFor("furnishing_dispute", id));
    assert(ev.includes("correction.propagation.due_at"), "deadline recorded");
    assert(!ev.includes("correction.propagated"), "no propagation event");
  });

  await t.step("a balance dispute corrected AND pushed to the bureaus is propagated", async () => {
    const lg = await api("POST", "/privacy/furnishing-disputes", { entity_ref: entity, field: "balance", disputed_value: "1200" }, { key: ops });
    assertEq(lg.status, 201, `dispute (${body(lg)})`);
    const id = `fdisp_${entity}_balance`;
    const r = await api("POST", `/privacy/furnishing-disputes/${id}/correct`, { corrected_value: "0", systems: ["metro2_equifax", "metro2_experian"] }, { key: ops });
    assertEq(r.status, 200, `correct (${body(r)})`);
    assertEq(r.body.data.propagated, true, "propagated");
    assert((await row("furnishing_dispute", id)).propagated_at, "propagated_at stamped");
    const ev = (await eventsFor("furnishing_dispute", id)).find((e) => e.code === "correction.propagated");
    assertEq(JSON.stringify(ev?.payload?.systems), JSON.stringify(["metro2_equifax", "metro2_experian"]), "systems named");
    const missing = await api("POST", `/privacy/furnishing-disputes/fdisp_${uid()}/correct`, { corrected_value: "x" }, { key: ops });
    assertEq(missing.status, 404, `unknown dispute (${body(missing)})`);
  });
});

// --------------------------------------------------------------- PR-03

flow("privacy: sharing member data — no legal basis is BLOCKED (and recorded), a vendor without a GLBA addendum is blocked, consent-based sharing proceeds", async (t) => {
  const partner = await actor("partner");
  const admin = await actor("cu_admin");
  let entity = "";

  const disclosuresOf = async (e: string) => {
    const r = await core().from("privacy_disclosure").select("*").eq("entity_id", e);
    assert(!r.error, `privacy_disclosure read: ${r.error?.message}`);
    return r.data ?? [];
  };

  await t.step("a partner cannot disclose on the CU's behalf (403 — route restricted to staff)", async () => {
    entity = await member(partner);
    const r = await api("POST", "/privacy/disclosures", { entity_id: entity, recipient: "Acme Lead Gen", legal_basis: "consent" }, { key: partner });
    assertEq(r.status, 403, `partner disclosure (${body(r)})`);
    assertEq((await disclosuresOf(entity)).length, 0, "nothing recorded");
  });

  await t.step("no legal basis → 422 privacy_sharing_blocked; the block is the evidence", async () => {
    const r = await api("POST", "/privacy/disclosures", { entity_id: entity, recipient: "Acme Lead Gen", data_scope: ["name", "balance"] }, { key: admin });
    assertEq(r.status, 422, `no basis (${body(r)})`);
    assertEq(r.body.type, "privacy_sharing_blocked", "typed refusal");
    const odd = await api("POST", "/privacy/disclosures", { entity_id: entity, recipient: "Acme Lead Gen", legal_basis: "we_asked_nicely" }, { key: admin });
    assertEq(odd.status, 422, `unrecognised basis (${body(odd)})`);
    const rows = await disclosuresOf(entity);
    assertEq(rows.length, 2, "both blocks recorded");
    assert(rows.every((d: Any) => d.blocked === true && d.blocked_reason), "blocked with a reason");
    for (const d of rows) {
      assert(codesOf(await eventsFor("privacy_disclosure", d.id)).includes("privacy.sharing.blocked"), "sharing.blocked");
    }
  });

  await t.step("a service-provider disclosure without the vendor's GLBA addendum is blocked", async () => {
    const r = await api("POST", "/privacy/disclosures", {
      entity_id: entity, recipient: "StatementPrint Co", legal_basis: "service_provider_glba", vendor_id: "vnd_statementprint",
    }, { key: admin });
    assertEq(r.status, 422, `no addendum (${body(r)})`);
    const d = (await disclosuresOf(entity)).find((x: Any) => x.vendor_id === "vnd_statementprint");
    assertEq(d?.blocked, true, "blocked on the record");
  });

  await t.step("consent-based sharing and a vendor WITH its addendum proceed, basis recorded", async () => {
    const c = await api("POST", "/privacy/disclosures", { entity_id: entity, recipient: "Budget App", legal_basis: "consent", data_scope: ["balance"] }, { key: admin });
    assertEq(c.status, 201, `consent (${body(c)})`);
    assertEq(c.body.data.blocked, false, "not blocked");
    const v = await api("POST", "/privacy/disclosures", {
      entity_id: entity, recipient: "StatementPrint Co", legal_basis: "service_provider_glba",
      vendor_id: "vnd_statementprint", vendor_glba_addendum_id: "glba_add_2026",
    }, { key: admin });
    assertEq(v.status, 201, `vendor (${body(v)})`);
    const d = await row("privacy_disclosure", v.body.data.id);
    assertEq(d.blocked, false, "allowed");
    assertEq(d.legal_basis, "service_provider_glba", "basis on the record");
    assertEq(d.vendor_glba_addendum_id, "glba_add_2026", "addendum on the record");
    const ev = codesOf(await eventsFor("privacy_disclosure", d.id));
    for (const code of ["disclosure.legal_basis.recorded", "disclosure.initiated", "vendor.glba_clause.verified"]) {
      assert(ev.includes(code), `${code} (got ${ev})`);
    }
  });
});

// --------------------------------------------------------------- PR-04

flow("privacy: who may see a member's data — the member, a documented POA, legal process; a stranger is refused, the refusal recorded, nothing disclosed", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  let entity = "";
  let name = "";

  const requestsOf = async (e: string) => {
    const r = await core().from("privacy_access_request").select("*").eq("entity_id", e);
    assert(!r.error, `privacy_access_request read: ${r.error?.message}`);
    return r.data ?? [];
  };

  await t.step("the member's own request is granted", async () => {
    name = personaName();
    const e = await api("POST", "/entities", { type: "person", name, date_of_birth: "1979-11-02", tin: "900-00-0000" }, { key: partner });
    assertEq(e.status, 201, `create entity (${body(e)})`);
    entity = String(e.body.id);
    const p = await api("POST", "/privacy/access-requests", { entity_id: entity, requester_kind: "self" }, { key: partner });
    assertEq(p.status, 403, `partner cannot log access requests (${body(p)})`);
    const r = await api("POST", "/privacy/access-requests", { entity_id: entity, requester_kind: "self" }, { key: ops });
    assertEq(r.status, 201, `self (${body(r)})`);
    assertEq((await row("privacy_access_request", r.body.data.id))?.status, "granted", "granted");
  });

  await t.step("a claimed POA with no artifact is rejected; a documented POA is granted", async () => {
    const r = await api("POST", "/privacy/access-requests", { entity_id: entity, requester_kind: "agent_poa", agent_identity: "J. Agent" }, { key: ops });
    assertEq(r.status, 422, `no artifact (${body(r)})`);
    assertEq(r.body.type, "poa_rejected", "typed refusal");
    const ok = await api("POST", "/privacy/access-requests", {
      entity_id: entity, requester_kind: "agent_poa", agent_identity: "J. Agent", poa_artifact_id: "poa_doc_1",
    }, { key: ops });
    assertEq(ok.status, 201, `documented POA (${body(ok)})`);
    const g = await row("privacy_access_request", ok.body.data.id);
    assertEq(g.status, "granted", "granted");
    assertEq(g.poa_artifact_id, "poa_doc_1", "the instrument is on the record");
  });

  await t.step("legal process needs the instrument itself", async () => {
    const r = await api("POST", "/privacy/access-requests", { entity_id: entity, requester_kind: "legal_process", rfpa_applicable: true }, { key: ops });
    assertEq(r.status, 422, `no instrument (${body(r)})`);
    assertEq(r.body.type, "legal_process_missing", "typed refusal");
    const ok = await api("POST", "/privacy/access-requests", {
      entity_id: entity, requester_kind: "legal_process", legal_process_artifact_id: "subpoena_77", rfpa_applicable: true,
    }, { key: ops });
    assertEq(ok.status, 201, `with instrument (${body(ok)})`);
    assertEq((await row("privacy_access_request", ok.body.data.id))?.rfpa_applicable, true, "RFPA applicability recorded");
  });

  await t.step("a stranger is refused (403), the refusal recorded, and the answer carries none of the member's data", async () => {
    const r = await api("POST", "/privacy/access-requests", { entity_id: entity, requester_kind: "other", agent_identity: "curious neighbour" }, { key: ops });
    assertEq(r.status, 403, `stranger (${body(r)})`);
    assertEq(r.body.type, "access_refused", "typed refusal");
    const raw = JSON.stringify(r.body);
    assert(!raw.includes(name) && !raw.includes("1979-11-02") && !raw.includes("900-00-0000"), "no PII in the refusal");
    const rows = await requestsOf(entity);
    const refused = rows.filter((x: Any) => x.status === "refused");
    assertEq(refused.length, 3, "POA, legal-process and stranger refusals all recorded");
    assert(refused.every((x: Any) => x.refusal_reason), "each refusal names its reason");
    const strangers = refused.filter((x: Any) => x.requester_kind === "other");
    assertEq(strangers.length, 1, "the stranger's refusal");
    assert(codesOf(await eventsFor("privacy_access_request", strangers[0].id)).includes("access.refused"), "access.refused");
  });
});

// --------------------------------------------------- PR-08 / PR-18 disposal + incident

flow("privacy: disposal certificate recorded; an incident notification decision — either way — needs its rationale", async (t) => {
  const ops = await actor("pynthia_ops");
  const record = `rec_${uid()}`;
  const incident = `inc_${uid()}`;

  await t.step("a destroyed record carries its certificate", async () => {
    const bad = await api("POST", "/privacy/disposal-certificates", { record_ref: record }, { key: ops });
    assertEq(bad.status, 400, `no certificate (${body(bad)})`);
    const r = await api("POST", "/privacy/disposal-certificates", {
      record_ref: record, certificate_ref: "cod_shredco_0042", method: "shredded", approved_by: "records_manager",
    }, { key: ops });
    assertEq(r.status, 201, `certificate (${body(r)})`);
    const ev = await eventsFor("record", record);
    const cert = ev.find((e) => e.code === "disposal.certificate.recorded");
    assertEq(cert?.payload?.certificate_ref, "cod_shredco_0042", "certificate on the record");
    assertEq(cert?.payload?.method, "shredded", "method");
    assert(codesOf(ev).includes("record.destruction_due_at"), "destruction date recorded");
  });

  await t.step("a decision NOT to notify without a rationale is refused; with one it is recorded, SAR referral too", async () => {
    const bad = await api("POST", `/privacy/incidents/${incident}/notification-decision`, { decision: "no_notify" }, { key: ops });
    assertEq(bad.status, 400, `no rationale (${body(bad)})`);
    assertEq((await eventsFor("incident", incident)).length, 0, "nothing recorded");
    const r = await api("POST", `/privacy/incidents/${incident}/notification-decision`, {
      decision: "no_notify", rationale: "encrypted laptop, key not compromised", material: false, sar_referred: true,
    }, { key: ops });
    assertEq(r.status, 201, `decision (${body(r)})`);
    const ev = await eventsFor("incident", incident);
    const d = ev.find((e) => e.code === "notification.decision.recorded");
    assertEq(d?.payload?.decision, "no_notify", "decision");
    assertEq(d?.payload?.["incident.material"], false, "materiality verdict");
    assert(codesOf(ev).includes("incident.sar_referred"), "SAR referral recorded");
  });
});

// --------------------------------------------------------------- PR-15

flow("privacy: third-party connection — partner grants a scoped token → in-scope read works → out-of-scope use revokes it → ops-recorded violation revokes", async (t) => {
  const partner = await actor("partner");
  const ops = await actor("pynthia_ops");
  let entity = "";
  let conn: Any = null;

  const sha = async (s: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");

  const connect = async () => {
    const r = await api("POST", "/privacy/connections", {
      entity_id: entity, party_id: "party_budgetapp", scopes: ["GET /entities/{id}"],
    }, { key: partner });
    assertEq(r.status, 201, `connect (${body(r)})`);
    return r.body.data;
  };

  await t.step("an unscoped connection is not consent", async () => {
    entity = await member(partner);
    const r = await api("POST", "/privacy/connections", { entity_id: entity, party_id: "party_budgetapp", scopes: [] }, { key: partner });
    assertEq(r.status, 400, `no scopes (${body(r)})`);
  });

  await t.step("the partner connects a third party: consent + token issued; only the hash is stored", async () => {
    conn = await connect();
    assert(String(conn.token).startsWith("cass_pt_conn_"), "plaintext returned once");
    const c = await row("connection", conn.id);
    assertEq(c?.entity_id, entity, "connection names the member");
    assertEq(c?.token_id, conn.token_id, "connection names its token");
    const tok = await row("api_token", conn.token_id);
    assertEq(tok?.token_hash, await sha(conn.token), "sha256 stored");
    assert(!JSON.stringify(tok).includes(conn.token), "the plaintext is stored nowhere on the token row");
    assertEq(JSON.stringify(tok?.allowed_endpoints), JSON.stringify(["GET /entities/{id}"]), "confined to the consented scope");
    assertEq(JSON.stringify(tok?.allowed_tiers), JSON.stringify(["read"]), "read-only");
    const ev = await eventsFor("connection", conn.id);
    assert(codesOf(ev).includes("connection.consent.granted") && codesOf(ev).includes("connection.token.issued"), "consent + issuance events");
    assert(!JSON.stringify(ev).includes(conn.token), "no event carries the plaintext");
  });

  await t.step("the token reads what it was consented to, and cannot write", async () => {
    const r = await api("GET", `/entities/${entity}`, undefined, { key: conn.token });
    assertEq(r.status, 200, `in-scope read (${body(r)})`);
    assertEq(r.body.id, entity, "the member");
    const w = await api("POST", "/entities", { type: "person", name: personaName(), date_of_birth: "1990-01-01" }, { key: conn.token });
    assertEq(w.status, 403, `write with a read-only connection (${body(w)})`);
  });

  await t.step("an out-of-scope request is refused AND revokes the connection in real time", async () => {
    const acct = await api("GET", "/accounts", undefined, { key: conn.token });
    assertEq(acct.status, 403, `out of scope (${body(acct)})`);
    assertEq(acct.body.type, "insufficient_scope", "typed refusal");
    // DEFECT: the router's insufficient_scope path never calls recordConnectionScopeViolation (privacy.ts:1249 claims it does); PR-15 requires immediate suspension
    const c = await row("connection", conn.id);
    assertEq(c?.status, "revoked", "scope violation revoked the connection");
    assertEq((await row("api_token", conn.token_id))?.status, "revoked", "and its token");
  });

  await t.step("ops records a violation on a second connection: connection + token revoked, the token stops working", async () => {
    const second = await connect();
    const ok = await api("GET", `/entities/${entity}`, undefined, { key: second.token });
    assertEq(ok.status, 200, `works before (${body(ok)})`);
    const p = await api("POST", `/privacy/connections/${second.id}/scope-violation`, { attempted: "GET /accounts" }, { key: partner });
    assertEq(p.status, 403, `a partner cannot record violations (${body(p)})`);
    const missing = await api("POST", `/privacy/connections/conn_${uid()}/scope-violation`, { attempted: "x" }, { key: ops });
    assertEq(missing.status, 404, `unknown connection (${body(missing)})`);
    const r = await api("POST", `/privacy/connections/${second.id}/scope-violation`, { attempted: "GET /accounts" }, { key: ops });
    assertEq(r.status, 200, `record violation (${body(r)})`);
    const c = await row("connection", second.id);
    assertEq(c?.status, "revoked", "revoked");
    assert(c?.revoked_at, "revoked_at stamped");
    assert(Number(c?.violation_count) >= 1, "violation counted");
    assertEq((await row("api_token", second.token_id))?.status, "revoked", "token revoked");
    const ev = codesOf(await eventsFor("connection", second.id));
    for (const code of ["connection.scope_violation.detected", "connection.suspended", "connection.token.revoked"]) {
      assert(ev.includes(code), `${code} (got ${ev})`);
    }
    const after = await api("GET", `/entities/${entity}`, undefined, { key: second.token });
    assertEq(after.status, 401, `revoked token (${body(after)})`);
  });
});
