// api — demo BaaS API slice (Supabase Edge Function, Deno).
//
// Auth: X-Api-Key = DEMO_API_KEY (verify_jwt = false). See README.

import { blnkConfigFromEnv } from "../_shared/blnk.ts";
import { getAccount, getAccounts, postAccount } from "./accounts.ts";
import { getTransfer, getTransfers, postTransfer } from "./transfers.ts";
import {
  postWireCancel,
  postWireConfirm,
  postWirePrepare,
  postWireReject,
  postWireReturn,
  postWireReturnResolve,
} from "./wires.ts";
import { getControlResults } from "./controls.ts";
import { getChangelog } from "./platform.ts";
import { postSandboxReset } from "./sandbox.ts";
import { postSimulate } from "./simulate.ts";
import { getDashboardEvents, getDashboardHeartbeat, getDashboardShell, getDashboardTrace, postDashboardFlag } from "./dashboard.ts";
import { postDeliverEvents, postEventSink } from "./events.ts";
import { postAch, postAchNoc, postAchReturn, postAchSettle } from "./ach.ts";
import { postCardAuthorize, postCardCapture, postCardExpire, postCardReverse } from "./cards.ts";
import { getAccountNumbers } from "./numbers.ts";
import { getCase } from "./bsa.ts";
import { getEntity } from "./entities.ts";
import { postPaymentApproval } from "./eps.ts";
import { postEstatePayout, postExpulsionClose } from "./member_protection.ts";
import { postProvisionalCredit } from "./complaints.ts";
import {
  createDb,
  createRequestId,
  internalErrorResponse,
  methodNotAllowedResponse,
  misconfiguredResponse,
  notFoundResponse,
} from "./lib.ts";
import { authenticate, type PartnerContext, type Route } from "./auth.ts";
import { generatedRoutes } from "./routes.gen.ts";

// The sentinel ctx for public routes. Deliberately hostile defaults: if a
// public handler ever DOES consult it, the partner actor class hits the most
// restrictive path everywhere (404 on BSA surfaces, scoped-out on rows).
const PUBLIC_CTX = {
  tokenId: "tok_public_shell",
  tokenPrefix: "none",
  actorType: "partner",
  roles: [],
  partnerId: null,
} as unknown as PartnerContext;

function stripFunctionPrefix(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "api") parts.shift();
  return "/" + parts.join("/");
}

// LENDING IS NOT ROUTED — narrow bank, deliberate. The standing exception is
// documented once, in CLAUDE.md ("One standing exception"); the drill still
// exercises those handlers directly.
//
// This array holds only the bespoke entries (inline chrome, Blnk-config
// injection, non-standard arg orders); everything else is generated from the
// spec into routes.gen.ts and spread at the end.
const routes: Route[] = [
  {
    method: "POST",
    pattern: /^\/accounts\/?$/,
    endpoint: "POST /accounts",
    tier: "write",
    paramNames: [],
    handler: async (req, _params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postAccount(req, db, cfg, requestId, ctx);
    },
  },
  {
    method: "GET",
    pattern: /^\/accounts\/?$/,
    endpoint: "GET /accounts",
    tier: "read",
    paramNames: [],
    handler: async (req, _params, requestId, ctx) => {
      const db = createDb();
      return await getAccounts(req, db, requestId, ctx);
    },
  },
  {
    method: "GET",
    pattern: /^\/accounts\/([^/]+)\/?$/,
    endpoint: "GET /accounts/{id}",
    tier: "read",
    paramNames: ["id"],
    handler: async (_req, params, requestId, ctx) => {
      const db = createDb();
      return await getAccount(params.id, db, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/transfers\/?$/,
    endpoint: "POST /transfers",
    tier: "write",
    paramNames: [],
    handler: async (req, _params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postTransfer(req, db, cfg, requestId, ctx);
    },
  },
  {
    method: "GET",
    pattern: /^\/transfers\/?$/,
    endpoint: "GET /transfers",
    tier: "read",
    paramNames: [],
    handler: async (req, _params, requestId, ctx) => {
      const db = createDb();
      return await getTransfers(req, db, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/sandbox\/event-sink\/?$/,
    endpoint: "POST /sandbox/event-sink",
    tier: "write",
    actors: ["pynthia_ops"],
    paramNames: [],
    handler: (_req, _params, requestId, _ctx) => Promise.resolve(postEventSink(requestId)),
  },
  {
    method: "POST",
    pattern: /^\/sandbox\/reset\/?$/,
    endpoint: "POST /sandbox/reset",
    tier: "write",
    actors: ["pynthia_ops"],
    paramNames: [],
    handler: async (req, _params, requestId, _ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postSandboxReset(req, db, cfg, requestId);
    },
  },
  {
    method: "POST",
    pattern: /^\/sandbox\/simulate(\/.*)?$/,
    endpoint: "POST /sandbox/simulate",
    tier: "write",
    paramNames: ["rest"],
    handler: async (req, params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postSimulate(req, params.rest ?? "/", db, cfg, requestId, ctx);
    },
  },
  {
    method: "GET",
    pattern: /^\/changelog\/?$/,
    endpoint: "GET /changelog",
    tier: "read",
    paramNames: [],
    handler: (_req, _params, requestId, _ctx) => Promise.resolve(getChangelog(requestId)),
  },
  {
    method: "GET",
    pattern: /^\/compliance\/dashboard\/?$/,
    paramNames: [],
    endpoint: "GET /compliance/dashboard",
    tier: "read",
    public: true,
    handler: async (_req, _params, requestId, _ctx) =>
      await Promise.resolve(getDashboardShell(requestId)),
  },
  {
    method: "GET",
    pattern: /^\/control-results\/?$/,
    endpoint: "GET /control-results",
    tier: "read",
    // NOT partner-scoped, deliberately. control_result is the INSTANCE's
    // compliance record: CTR aggregation, structuring detection and BSA
    // reporting are obligations of the chartered credit union across every
    // fintech it hosts. Narrowing this per partner would fragment exactly the
    // view the controls exist to produce. See ownership.ts
    // INSTANCE_SCOPED_TABLES.
    paramNames: [],
    handler: async (req, _params, requestId, _ctx) => {
      const db = createDb();
      return await getControlResults(req, db, requestId);
    },
  },
  {
    method: "GET",
    pattern: /^\/transfers\/([^/]+)\/?$/,
    endpoint: "GET /transfers/{id}",
    tier: "read",
    paramNames: ["id"],
    handler: async (_req, params, requestId, ctx) => {
      const db = createDb();
      return await getTransfer(params.id, db, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/ach\/?$/,
    endpoint: "POST /payments/ach",
    tier: "write",
    paramNames: [],
    handler: async (req, _params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postAch(req, db, cfg, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/ach\/([^/]+)\/settle\/?$/,
    endpoint: "POST /payments/ach/{id}/settle",
    tier: "write",
    paramNames: ["id"],
    handler: async (req, params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postAchSettle(req, params.id, db, cfg, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/ach\/([^/]+)\/return\/?$/,
    endpoint: "POST /payments/ach/{id}/return",
    tier: "write",
    paramNames: ["id"],
    handler: async (req, params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postAchReturn(req, params.id, db, cfg, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/ach\/([^/]+)\/noc\/?$/,
    endpoint: "POST /payments/ach/{id}/noc",
    tier: "write",
    paramNames: ["id"],
    handler: async (req, params, requestId, ctx) => {
      // no Blnk config: a notification of change moves no money
      const db = createDb();
      return await postAchNoc(req, params.id, db, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/card\/authorize\/?$/,
    endpoint: "POST /payments/card/authorize",
    tier: "realtime",
    paramNames: [],
    handler: async (req, _params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postCardAuthorize(req, db, cfg, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/card\/([^/]+)\/capture\/?$/,
    endpoint: "POST /payments/card/{id}/capture",
    tier: "realtime",
    paramNames: ["id"],
    handler: async (req, params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postCardCapture(req, params.id, db, cfg, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/card\/([^/]+)\/reverse\/?$/,
    endpoint: "POST /payments/card/{id}/reverse",
    tier: "realtime",
    paramNames: ["id"],
    handler: async (req, params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postCardReverse(req, params.id, db, cfg, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/card\/([^/]+)\/expire\/?$/,
    endpoint: "POST /payments/card/{id}/expire",
    tier: "realtime",
    paramNames: ["id"],
    handler: async (req, params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postCardExpire(req, params.id, db, cfg, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/wire\/prepare\/?$/,
    endpoint: "POST /payments/wire/prepare",
    tier: "write",
    paramNames: [],
    handler: async (req, _params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postWirePrepare(req, db, cfg, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/wire\/([^/]+)\/confirm\/?$/,
    endpoint: "POST /payments/wire/{id}/confirm",
    tier: "write",
    paramNames: ["id"],
    handler: async (req, params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postWireConfirm(req, params.id, db, cfg, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/wire\/([^/]+)\/cancel\/?$/,
    endpoint: "POST /payments/wire/{id}/cancel",
    tier: "write",
    paramNames: ["id"],
    handler: async (req, params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postWireCancel(req, params.id, db, cfg, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/wire\/([^/]+)\/reject\/?$/,
    endpoint: "POST /payments/wire/{id}/reject",
    tier: "write",
    paramNames: ["id"],
    handler: async (req, params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postWireReject(req, params.id, db, cfg, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/wire\/([^/]+)\/return\/resolve\/?$/,
    endpoint: "POST /payments/wire/{id}/return/resolve",
    tier: "write",
    paramNames: ["id"],
    handler: async (req, params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postWireReturnResolve(req, params.id, db, cfg, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/payments\/wire\/([^/]+)\/return\/?$/,
    endpoint: "POST /payments/wire/{id}/return",
    tier: "write",
    paramNames: ["id"],
    handler: async (req, params, requestId, ctx) => {
      const db = createDb();
      const cfg = blnkConfigFromEnv();
      return await postWireReturn(req, params.id, db, cfg, requestId, ctx);
    },
  },
  {
    method: "POST",
    pattern: /^\/events\/deliver\/?$/,
    endpoint: "POST /events/deliver",
    tier: "write",
    actors: ["pynthia_ops"],
    paramNames: [],
    handler: async (req, _params, requestId, _ctx) => await postDeliverEvents(req, createDb(), requestId),
  },
  {
    method: "GET",
    pattern: /^\/entities\/([^/]+)\/?$/,
    endpoint: "GET /entities/{id}",
    tier: "read",
    paramNames: ["id"],
    handler: async (_req, params, requestId, ctx) => await getEntity(params.id, createDb(), requestId, ctx),
  },
  {
    method: "GET",
    pattern: /^\/accounts\/([^/]+)\/numbers\/?$/,
    endpoint: "GET /accounts/{id}/numbers",
    tier: "read",
    paramNames: ["id"],
    handler: async (_req, params, requestId, ctx) => await getAccountNumbers(params.id, createDb(), requestId, ctx),
  },
  {
    method: "POST",
    pattern: /^\/payments\/wire\/([^/]+)\/approve\/?$/,
    paramNames: ["id"],
    endpoint: "POST /payments/wire/{id}/approve",
    tier: "write",
    handler: async (req, params, requestId, ctx) =>
      await postPaymentApproval(req, "wire_transfer", params.id, createDb(), requestId, ctx),
  },
  {
    method: "POST",
    pattern: /^\/payments\/ach\/([^/]+)\/approve\/?$/,
    paramNames: ["id"],
    endpoint: "POST /payments/ach/{id}/approve",
    tier: "write",
    handler: async (req, params, requestId, ctx) =>
      await postPaymentApproval(req, "ach_transfer", params.id, createDb(), requestId, ctx),
  },
  {
    method: "GET",
    pattern: /^\/bsa\/cases\/([^/]+)\/?$/,
    paramNames: ["id"],
    endpoint: "GET /bsa/cases/{id}",
    tier: "read",
    handler: async (_req, params, requestId, ctx) =>
      await getCase(params.id, createDb(), requestId, ctx),
  },
  {
    method: "GET",
    pattern: /^\/compliance\/dashboard\/heartbeat\/?$/,
    paramNames: [],
    endpoint: "GET /compliance/dashboard/heartbeat",
    tier: "read",
    public: true,
    handler: async (req, _params, requestId, _ctx) =>
      await getDashboardHeartbeat(req, createDb(), requestId),
  },
  {
    method: "GET",
    pattern: /^\/compliance\/dashboard\/events\/?$/,
    paramNames: [],
    endpoint: "GET /compliance/dashboard/events",
    tier: "read",
    public: true,
    handler: async (req, _params, requestId, _ctx) =>
      await getDashboardEvents(req, createDb(), requestId),
  },
  {
    method: "GET",
    pattern: /^\/compliance\/dashboard\/trace\/([^/]+)\/?$/,
    paramNames: ["resourceId"],
    endpoint: "GET /compliance/dashboard/trace/{resourceId}",
    tier: "read",
    public: true,
    handler: async (_req, params, requestId, _ctx) =>
      await getDashboardTrace(params.resourceId, createDb(), requestId),
  },
  // The dashboard's one WRITE: an officer flags a monitored event, which routes
  // an escalation (sim scope, unauthenticated — the demo posture the other
  // dashboard routes already have; see postDashboardFlag's header for the
  // deferred production auth model).
  {
    method: "POST",
    pattern: /^\/compliance\/dashboard\/flag\/?$/,
    paramNames: [],
    endpoint: "POST /compliance/dashboard/flag",
    tier: "write",
    public: true,
    handler: async (req, _params, requestId, _ctx) =>
      await postDashboardFlag(req, createDb(), requestId),
  },
  // Both payout routes are hand-wired for one reason: they need Blnk. A payout
  // is sized from the member's LEDGER balance, not from core.account.balance
  // (see memberBalanceCents), so these two handlers take a BlnkConfig and the
  // generated signature cannot supply one.
  {
    // hand-routed: posts the Reg E credit to the ledger, so it takes the Blnk
    // config (and the drill injects a fake one). Self-gates internal actors.
    method: "POST",
    pattern: /^\/disputes\/([^/]+)\/provisional-credit\/?$/,
    paramNames: ["id"],
    endpoint: "POST /disputes/{id}/provisional-credit",
    tier: "write",
    handler: async (req, params, requestId, ctx) =>
      await postProvisionalCredit(req, params.id, createDb(), blnkConfigFromEnv(), requestId, ctx),
  },
  {
    method: "POST",
    pattern: /^\/estate-claims\/([^/]+)\/payout\/?$/,
    paramNames: ["id"],
    endpoint: "POST /estate-claims/{id}/payout",
    tier: "write",
    actors: ["cu_admin", "pynthia_ops"],
    handler: async (req, params, requestId, ctx) =>
      await postEstatePayout(req, params.id, createDb(), blnkConfigFromEnv(), requestId, ctx),
  },
  {
    method: "POST",
    pattern: /^\/expulsions\/([^/]+)\/close\/?$/,
    paramNames: ["id"],
    endpoint: "POST /expulsions/{id}/close",
    tier: "write",
    actors: ["cu_admin", "pynthia_ops"],
    handler: async (req, params, requestId, ctx) =>
      await postExpulsionClose(req, params.id, createDb(), blnkConfigFromEnv(), requestId, ctx),
  },
  // Everything else is generated from the spec — see routes.gen.ts.
  ...generatedRoutes,
];

function matchRoute(path: string, method: string): { route: Route; params: Record<string, string> } | "not_found" | "method_not_allowed" {
  // Keep scanning past a path match with the wrong method: one pattern can
  // legitimately serve several methods from separate routes (POST /entities
  // creates, GET /entities lists). Breaking on the first path match made every
  // later same-pattern route unreachable — surfaced as a 405 on GET /entities.
  let sawPathMatch = false;
  for (const route of routes) {
    const m = path.match(route.pattern);
    if (!m) continue;
    sawPathMatch = true;
    if (route.method !== method) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, i) => {
      params[name] = m[i + 1];
    });
    return { route, params };
  }
  return sawPathMatch ? "method_not_allowed" : "not_found";
}

Deno.serve(async (req: Request): Promise<Response> => {
  const requestId = createRequestId();

  // The instance this process IS (card 51). Read from the environment, never
  // from the request: a caller-supplied instance id would let any token claim
  // to belong here. Absent config fails closed — an instance that does not
  // know its own identity cannot decide whether a token is foreign.
  const instanceId = Deno.env.get("INSTANCE_ID");
  if (!instanceId) {
    return misconfiguredResponse(requestId, "server misconfigured: INSTANCE_ID unset");
  }

  const url = new URL(req.url);
  const path = stripFunctionPrefix(url.pathname);

  // The dashboard shell is hosted cross-origin (GitHub Pages — the gateway
  // rewrites HTML content-types on shared domains), so its data route speaks
  // CORS. This must run BEFORE route matching: an OPTIONS preflight matches
  // no GET route and would 405. Wildcard origin is safe here: CORS is not
  // the protection — the X-Api-Key header is, and browsers only send it
  // because this preflight allows it. Auth failures carry the header too, or
  // the browser would swallow the 401 and the shell could not explain the
  // refusal.
  const corsRoute =
    /^\/compliance\/dashboard\/(?:data|heartbeat|events|flag|trace\/[^/]+)\/?$/.test(path);
  if (corsRoute && req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        // flag is the one POST (see the route table); the rest are GETs
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "x-api-key, authorization, content-type",
        "access-control-max-age": "86400",
      },
    });
  }
  const withCors = (res: Response): Response => {
    if (corsRoute) res.headers.set("access-control-allow-origin", "*");
    return res;
  };

  const matched = matchRoute(path, req.method);

  // Route resolution BEFORE auth, because the scope check needs to know which
  // endpoint is being asked for. The 404/405 below therefore leak the shape of
  // the route table to an unauthenticated caller — an accepted trade: the route
  // table is public API surface documented in the README, and the alternative
  // (authenticate against an unknown scope) cannot be done coherently.
  if (matched === "not_found") {
    return notFoundResponse(requestId, "route", path);
  }
  if (matched === "method_not_allowed") {
    return methodNotAllowedResponse(requestId);
  }

  // Pure-chrome public routes (dashboard shell) skip authentication: they
  // carry zero data. The sentinel ctx's partner actor class means a handler
  // that wrongly consults it hits the most restrictive path everywhere.
  if (matched.route.public) {
    try {
      const res = await matched.route.handler(req, matched.params, requestId, PUBLIC_CTX);
      res.headers.set("X-RateLimit-Tier", matched.route.tier);
      return withCors(res);
    } catch (e) {
      return withCors(internalErrorResponse(requestId, e));
    }
  }

  const db = createDb();
  const auth = await authenticate(
    req,
    db,
    matched.route,
    instanceId,
    requestId,
    {
      key: Deno.env.get("DEMO_API_KEY"),
      // opt-OUT rather than opt-in, so an existing deployment keeps working on
      // upgrade; production sets this to "false". See auth.ts.
      enabled: Deno.env.get("ALLOW_DEMO_KEY") !== "false",
    },
  );
  if (!auth.ok) return withCors(auth.response);

  try {
    const res = await matched.route.handler(req, matched.params, requestId, auth.ctx);
    // D14: surface which tier the request was billed against, so partners can
    // reconcile their own usage. The limits themselves are a separate card.
    res.headers.set("X-RateLimit-Tier", matched.route.tier);
    return withCors(res);
  } catch (e) {
    return withCors(internalErrorResponse(requestId, e));
  }
});
