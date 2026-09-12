// Server-side core-API WRITE client — the UI's single write door. NEVER import
// this from a component.
//
// Its read counterpart (coreApi.js) is an allowlist of GET paths because the
// alternative would hand the browser the server credential and the whole write
// half of the API with it. This module is the deliberate, narrow exception:
// exactly ONE write is reachable from this UI — routing an escalation from a
// flagged compliance event (POST /compliance/dashboard/flag). It is not a
// generic write proxy and must never become one; every other write (POST
// /transfers moves real money) stays reachable only through the core API
// directly, never from a browser holding this UI.
//
// The X-Api-Key is read from the same server-only env as coreApi.js and never
// crosses to the client.

import { CoreApiError } from "./coreApi";

const BASE_URL = process.env.CORE_API_URL;
const API_KEY = process.env.CORE_API_KEY;

// The one path this door opens. A literal, not a parameter: there is no caller
// that should be able to choose a different write target through here.
const FLAG_PATH = "compliance/dashboard/flag";

/**
 * Route an escalation for a flagged event. Throws CoreApiError on a non-2xx so
 * the route can pass the core's own status and error body straight through.
 */
export async function coreFlag(payload) {
  if (!BASE_URL || !API_KEY) {
    throw new CoreApiError(503, {
      detail:
        "CORE_API_URL and CORE_API_KEY are unset — copy ui/.env.local.example to " +
        "ui/.env.local and fill them in. See ui/README.md.",
    });
  }

  const res = await fetch(`${BASE_URL.replace(/\/$/, "")}/${FLAG_PATH}`, {
    method: "POST",
    headers: {
      "X-Api-Key": API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new CoreApiError(res.status, body);
  return body;
}
