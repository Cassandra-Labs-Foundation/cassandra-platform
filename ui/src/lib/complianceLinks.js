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
