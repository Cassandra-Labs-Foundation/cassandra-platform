// The bridge between the Approvals queue and the compliance monitoring pages.
//
// Both are views of the same evidence, and both now live in THIS app: the
// monitoring pages (/compliance/dashboard) watch every control; the Approvals
// queue is what two of those controls (EPS-06 wire dual control, and the
// money-movement gate's CG-* checks) actually held, blocked, or rejected. This
// module turns a control id into the exact in-app place its full event history
// lives, and back — so a flag in the queue is one click from the control that
// raised it, with no bounce to a separate deployment.
//
// These used to point at a standalone GitHub-Pages dashboard
// (NEXT_PUBLIC_COMPLIANCE_DASHBOARD_URL); the dashboard was ported into this
// app, so the links are internal Next routes now.
import { useEffect, useState } from "react";
import { fetchDashboardManifest } from "./api";

// Which monitoring policy a control belongs to, by id prefix. These two
// policies are the only ones whose controls surface in the approval/flag
// queues; anything else falls back to the monitoring index rather than
// guessing a wrong slug.
const POLICY_SLUG = [
  ["CG-", "money-movement-gate"],
  ["EPS-", "electronic-payment-systems"],
  ["SC-", "electronic-payment-systems"],
];

/** Human-readable name for the gate/EPS controls that reach the queue. */
export const CONTROL_LABEL = {
  "EPS-06": "Wire dual control",
  "CG-OFAC-01": "OFAC sanctions screening",
  "CG-NSF-01": "Insufficient funds (NSF)",
  "CG-VEL-01": "Velocity limit",
  "CG-STR-01": "Structuring detection",
  "CG-STR-02": "Structuring detection",
  "CG-CTR-01": "Currency transaction report (CTR)",
  "CG-LGTXN-01": "Large-transaction review",
};

/** The control code out of a free-text basis ("EPS-06: wire dual control…" → "EPS-06"). */
export function controlCodeFromBasis(basis) {
  const m = /^([A-Z]{2,}-[A-Z0-9-]+?)\s*[:—-]/.exec(String(basis ?? "").trim());
  return m ? m[1] : null;
}

export function controlPolicySlug(controlId) {
  const id = String(controlId ?? "");
  for (const [prefix, slug] of POLICY_SLUG) if (id.startsWith(prefix)) return slug;
  return null;
}

/** The monitoring overview, in-app. */
export function dashboardHomeUrl() {
  return "/compliance/dashboard";
}

/**
 * In-app deep link to one control's evidence on the monitoring pages. The
 * policy page reads ?c=<controlId> and opens straight to that control's history
 * (matching on the short id or the full uid). Unknown controls land on the
 * monitoring index.
 */
export function dashboardControlUrl(controlId) {
  const slug = controlPolicySlug(controlId);
  if (!slug) return dashboardHomeUrl();
  return `/compliance/dashboard/${slug}?c=${encodeURIComponent(controlId)}`;
}

/**
 * The reverse link: where a control's actionable queue lives in this app.
 * Only the money-movement gate's checks and EPS-06 have one; returns null for
 * controls with nothing to review. `control` is a manifest control ({id, uid}).
 */
export function approvalsQueueUrl(control) {
  const uid = (control && control.uid) || "";
  if (uid.startsWith("money-movement-gate:") || uid === "electronic-payment-systems:EPS-06") {
    return `/approvals?control=${encodeURIComponent(control.id)}`;
  }
  return null;
}

/** Where a flagged subject_ref resolves inside this app, or null if it doesn't. */
export function subjectHref(subjectRef) {
  const ref = String(subjectRef ?? "");
  if (ref.startsWith("acct_")) return `/accounts/${ref}`;
  if (ref.startsWith("ent_")) return `/members/${ref}`;
  return null;
}

// ─────────────────────────────────────────── the general control resolver
//
// The hardcoded POLICY_SLUG / CONTROL_LABEL tables above cover only the two
// policies whose controls reach the Approvals queue. The rest of the console
// (Reports, the governance calendar) names controls from every policy, so it
// resolves against the control catalogue itself — the same static manifest the
// monitoring pages read (28 policies, 339 controls; each control carries a
// short `id` like BSA-01 and a policy-qualified `uid` like bsa:BSA-01).
//
// The one rule that keeps every link honest: a short id is only a link when it
// resolves to EXACTLY one control. A handful of short ids (SC-01/02/03) live in
// eight or nine policies at once, so a bare `control_id` off core.control_result
// is ambiguous; resolving it to a guessed policy is the "link to nowhere"
// problem wearing a confident face. Ambiguous or unknown ids resolve to null
// and stay plain text.

/**
 * Build an index over a fetched manifest.
 *
 *   byUid.get("bsa:BSA-01")  -> the one control (uid is unique by construction)
 *   byId.get("SC-02")        -> every control sharing that short id (1..n)
 *   resolve(idOrUid)         -> the unique control, or null when 0 or >1 match
 *
 * A resolved control is `{ id, uid, slug, title, policyTitle }` — everything a
 * link needs without a second lookup.
 */
export function buildControlIndex(manifest) {
  const byUid = new Map();
  const byId = new Map();
  for (const p of manifest?.policies ?? []) {
    for (const c of p.controls ?? []) {
      const entry = { id: c.id, uid: c.uid, slug: p.slug, title: c.title, policyTitle: p.title };
      byUid.set(c.uid, entry);
      const bucket = byId.get(c.id) ?? [];
      bucket.push(entry);
      byId.set(c.id, bucket);
    }
  }
  const resolve = (key) => {
    if (!key) return null;
    if (byUid.has(key)) return byUid.get(key); // full uid — unambiguous
    const bucket = byId.get(key); // short id — unique only if the bucket is a singleton
    return bucket && bucket.length === 1 ? bucket[0] : null;
  };
  return { byUid, byId, resolve };
}

/**
 * Load the control catalogue once and hand back a resolver.
 *
 * Lean on purpose: unlike useDashboard(), this fetches ONLY the manifest, not
 * the heartbeat + live aggregates — the pages that cross-link (Reports, the
 * calendar) need the id→policy map, not the pulse. While it loads, `index` is
 * null and every resolve() returns null, so links simply render as text and
 * upgrade to links the moment the manifest lands. A failed fetch is the same
 * quiet degradation, never a thrown render.
 */
export function useControlIndex() {
  const [index, setIndex] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchDashboardManifest()
      .then((m) => { if (!cancelled) setIndex(buildControlIndex(m)); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);

  return { index, error, loading: index === null && !error };
}

/** In-app link to a resolved control's audit surface on the monitoring pages. */
export function monitoringUrlForControl(entry) {
  if (!entry) return null;
  return `/compliance/dashboard/${entry.slug}?c=${encodeURIComponent(entry.id)}`;
}

/** In-app link to a control's recorded decisions in Reports, optionally scoped to one subject. */
export function reportsUrlForControl(controlId, { subjectRef } = {}) {
  if (!controlId) return null;
  const qs = new URLSearchParams({ control_id: controlId });
  if (subjectRef) qs.set("subject_ref", subjectRef);
  return `/reports?${qs.toString()}`;
}

/** In-app link to a control's obligations on the governance calendar (focuses by uid). */
export function calendarUrlForControl(uid) {
  if (!uid) return null;
  return `/compliance?control_uid=${encodeURIComponent(uid)}`;
}
