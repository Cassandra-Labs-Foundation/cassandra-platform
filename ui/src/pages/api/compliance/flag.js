// The UI's one write route: flag a monitored compliance event and route an
// escalation. POST only.
//
// Mirrors the read proxies' habits — the credential stays server-side
// (lib/coreWrite.js), and the core API's own error body is passed through
// intact so a 400 arrives as that 400 with its field detail, not an opaque
// 500. It differs in exactly one way, on purpose: it forwards a POST, and to
// exactly one core path (coreWrite pins it). It validates the body here so a
// malformed flag fails with a clear message before it costs a round trip.

import { CoreApiError } from "../../../lib/coreApi";
import { coreFlag } from "../../../lib/coreWrite";

const SEVERITIES = ["routine", "elevated", "urgent"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ detail: "this route only accepts POST" });
  }

  const b = req.body ?? {};
  const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

  // Required to make a real escalation: which event, which control, and to whom.
  const missing = ["event_id", "event_code", "control_uid", "routed_to"].filter((k) => !str(b[k]));
  if (missing.length) {
    return res.status(400).json({ detail: `missing required field(s): ${missing.join(", ")}` });
  }
  if (!SEVERITIES.includes(b.severity)) {
    return res.status(400).json({ detail: `severity must be one of: ${SEVERITIES.join(", ")}` });
  }

  const payload = {
    // A flag with no resource is valid — some events carry no resource_id.
    resource_ref: str(b.resource_ref) || null,
    event_id: str(b.event_id),
    event_code: str(b.event_code),
    control_uid: str(b.control_uid),
    routed_to: str(b.routed_to),
    severity: b.severity,
    note: str(b.note),
  };

  try {
    return res.status(200).json(await coreFlag(payload));
  } catch (e) {
    if (e instanceof CoreApiError) return res.status(e.status).json(e.body ?? { detail: e.message });
    console.error("flag route failed:", e);
    return res.status(502).json({ detail: "could not reach the core API" });
  }
}
