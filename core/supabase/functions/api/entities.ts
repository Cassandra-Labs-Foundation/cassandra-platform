// Entities (cards 19-23): the people and organizations behind accounts.
//
// Four types share one table and one lifecycle. Transitions EMIT events
// (card 22) — the entity history is what KYC/CDD reviews replay, so a status
// change that leaves no event is invisible to compliance.
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  apiError,
  claimIdempotency,
  internalErrorResponse,
  isNonEmptyString,
  jsonResponse,
  notFoundResponse,
  pageEnvelope,
  paginate,
  parseJsonBody,
  parsePageParams,
  sha256Hex,
  storeIdempotencyResponse,
  validationError,
  type ValidationErrorItem,
  idempotencyInProgressResponse,
} from "./lib.ts";
import { scopeToPartner, withOwner } from "./ownership.ts";
import { type PartnerContext } from "./auth.ts";

const TYPES = ["person", "business", "trust", "joint"] as const;
type EntityType = typeof TYPES[number];

// Per-type minimums: what an examiner would expect to identify the party.
const REQUIRED: Record<EntityType, { field: string; message: string }[]> = {
  person: [{ field: "date_of_birth", message: "a person needs a date_of_birth" }],
  business: [{ field: "tin", message: "a business needs a tin" }],
  trust: [{ field: "jurisdiction", message: "a trust needs a jurisdiction" }],
  joint: [],
};

// Card 22 state machine. pending must go through active before it can be
// archived — archiving an entity that was never activated would erase a
// membership application rather than close a membership.
const TRANSITIONS: Record<string, string[]> = {
  pending: ["active", "disabled"],
  active: ["disabled", "archived"],
  disabled: ["active", "archived"],
  archived: [],
};

const ENTITY_COLS = "id, type, name, status, email, date_of_birth, tin, jurisdiction, address, owners, created_at";

function entityResponse(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    status: row.status,
    email: row.email ?? null,
    date_of_birth: row.date_of_birth ?? null,
    tin: row.tin ?? null,
    jurisdiction: row.jurisdiction ?? null,
    address: row.address ?? null,
    owners: row.owners ?? [],
    created_at: row.created_at,
  };
}

async function emitEntityEvent(
  db: SupabaseClient,
  code: string,
  resourceType: string,
  resourceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Transitions can legally repeat (active -> disabled -> active), so each
  // occurrence is its own event: random id, no dedupe.
  const { error } = await db.schema("core").from("event").insert({
    id: `evt_${crypto.randomUUID()}`,
    code,
    type: resourceType,
    resource_id: resourceId,
    entity_hash: await sha256Hex(resourceId),
    payload,
    created_at: new Date().toISOString(),
  });
  if (error) console.error(`event emit failed (${code} ${resourceId}): ${error.message}`);
}

/** POST /entities — create a person/business/trust/joint; starts PENDING. */
export async function postEntity(
  req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const raw = await parseJsonBody(req).catch(() => null);
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};

  const errors: ValidationErrorItem[] = [];
  const type = body.type;
  if (!isNonEmptyString(type) || !TYPES.includes(type as EntityType)) {
    errors.push({ type: "invalid_value", field: "type", message: `must be one of: ${TYPES.join(", ")}` });
  }
  if (!isNonEmptyString(body.name)) {
    errors.push({ type: "missing_field", field: "name", message: "name is required" });
  }
  if (isNonEmptyString(type) && TYPES.includes(type as EntityType)) {
    for (const r of REQUIRED[type as EntityType]) {
      if (!isNonEmptyString(body[r.field])) {
        errors.push({ type: "missing_field", field: r.field, message: r.message });
      }
    }
  }
  if (errors.length) return validationError(requestId, errors);

  const fields = {
    type,
    name: body.name,
    email: isNonEmptyString(body.email) ? body.email : null,
    date_of_birth: isNonEmptyString(body.date_of_birth) ? body.date_of_birth : null,
    tin: isNonEmptyString(body.tin) ? body.tin : null,
    jurisdiction: isNonEmptyString(body.jurisdiction) ? body.jurisdiction : null,
    address: isNonEmptyString(body.address) ? body.address : null,
  };

  // D6, as the spec declares for create_entity: a partner retrying a timed-out
  // create with the same Idempotency-Key gets the first member back, and the
  // same key for a different person is a 409. This handler used to ignore the
  // header, so every retry minted a duplicate member — a CIP problem, since
  // one person then holds two identities (caught by the partner-flow suite).
  // The key stays optional: a create without one is not deduplicated.
  let id = `ent_${crypto.randomUUID()}`;
  const idempotencyKey = req.headers.get("Idempotency-Key");
  if (idempotencyKey) {
    const claim = await claimIdempotency(
      db, ctx.idempotencyScope, idempotencyKey, await sha256Hex(JSON.stringify(fields)), id, "POST /entities",
    );
    if (claim.kind === "replay") {
      return jsonResponse(claim.responseBody, claim.responseStatus, requestId, { "Idempotent-Replayed": "true" });
    }
    if (claim.kind === "in_progress") return idempotencyInProgressResponse(requestId);
    if (claim.kind === "conflict") {
      return apiError(409, "idempotency_key_reused", requestId, {
        title: "Idempotency Key Reused",
        detail: "Idempotency-Key was used with a different request body",
      });
    }
    id = claim.transferId;
  }

  const row: Record<string, unknown> = { id, ...fields, status: "pending", owners: [] };
  const { error } = await db.schema("core").from("entity").insert(withOwner(row, ctx));
  // 23505 on a resumed claim: the earlier attempt inserted the row and died
  // before storing its response — the member exists, so finish the job.
  if (error && error.code !== "23505") return internalErrorResponse(requestId, error);
  if (!error) await emitEntityEvent(db, "entity.created", "entity", id, { type, name: body.name });

  const responseBody = entityResponse({ ...row, created_at: new Date().toISOString() });
  if (idempotencyKey) await storeIdempotencyResponse(db, ctx.idempotencyScope, idempotencyKey, 201, responseBody);
  return jsonResponse(responseBody, 201, requestId);
}

/** GET /entities — unified list across types; ?type= filters; paginated. */
export async function getEntities(
  req: Request,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const { limit, after, errors } = parsePageParams(q);
  const type = q.get("type");
  if (type !== null && !TYPES.includes(type as EntityType)) {
    errors.push({ type: "invalid_value", field: "type", message: `must be one of: ${TYPES.join(", ")}` });
  }
  if (errors.length) return validationError(requestId, errors);

  // scoped before the type/cursor filters so a partner's page can never
  // contain another partner's entity, whatever the query string asks for
  let query = scopeToPartner(
    db.schema("core").from("entity").select(ENTITY_COLS),
    ctx,
  )
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (type) query = query.eq("type", type);
  if (after) query = query.lt("created_at", after);

  const { data, error } = await query;
  if (error) return internalErrorResponse(requestId, error);
  const { page, has_more, next_after } = paginate(
    (data ?? []) as Record<string, unknown>[],
    limit,
  );
  return jsonResponse(
    pageEnvelope(page.map(entityResponse), { limit, has_more, next_after }),
    200,
    requestId,
  );
}

/** GET /entities/{id} */
export async function getEntity(
  entityId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const { data, error } = await scopeToPartner(
    db.schema("core").from("entity").select(ENTITY_COLS).eq("id", entityId),
    ctx,
  ).maybeSingle();
  if (error) return internalErrorResponse(requestId, error);
  if (!data) return notFoundResponse(requestId, "entity", entityId);
  return jsonResponse(entityResponse(data as Record<string, unknown>), 200, requestId);
}

/** POST /entities/{id}/transition {to} — card 22. */
export async function postEntityTransition(
  req: Request,
  entityId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const raw = await parseJsonBody(req).catch(() => null);
  const to = raw && typeof raw === "object" ? (raw as Record<string, unknown>).to : undefined;
  if (!isNonEmptyString(to) || !(to in TRANSITIONS)) {
    return validationError(requestId, [{
      type: "invalid_value",
      field: "to",
      message: `must be one of: ${Object.keys(TRANSITIONS).join(", ")}`,
    }]);
  }

  const { data: ent, error: selErr } = await scopeToPartner(
    db.schema("core").from("entity").select(ENTITY_COLS).eq("id", entityId),
    ctx,
  ).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!ent) return notFoundResponse(requestId, "entity", entityId);

  const from = String((ent as Record<string, unknown>).status);
  if (!(TRANSITIONS[from] ?? []).includes(to)) {
    return apiError(409, "invalid_state", requestId, {
      title: "Invalid State",
      detail: `entity ${entityId} is ${from}; legal transitions: ${(TRANSITIONS[from] ?? []).join(", ") || "(none — terminal)"}`,
    });
  }

  const { data: updated, error: updErr } = await db.schema("core").from("entity")
    .update({ status: to }).eq("id", entityId).select(ENTITY_COLS).single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  // The state name is an adjective; the event announces the transition in the
  // registry's verb form. `entity.activated` is what the vocabulary registers —
  // emitting `entity.active` left the registered code permanently silent.
  const stateEvent: Record<string, string> = { active: "entity.activated" };
  await emitEntityEvent(db, stateEvent[to] ?? `entity.${to}`, "entity", entityId, { from, to });
  return jsonResponse(entityResponse(updated as Record<string, unknown>), 200, requestId);
}

/** POST /entities/{id}/owners — card 23; business/trust only. */
export async function postEntityOwner(
  req: Request,
  entityId: string,
  db: SupabaseClient,
  requestId: string,
  ctx: PartnerContext,
): Promise<Response> {
  const raw = await parseJsonBody(req).catch(() => null);
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};

  const errors: ValidationErrorItem[] = [];
  if (!isNonEmptyString(body.owner_entity_id)) {
    errors.push({ type: "missing_field", field: "owner_entity_id", message: "the owning entity's id is required" });
  }
  const percent = body.ownership_percent;
  // whole or two-decimal percents in (0, 100]
  if (
    typeof percent !== "number" || percent <= 0 || percent > 100 ||
    Math.round(percent * 100) !== percent * 100
  ) {
    errors.push({
      type: "invalid_value",
      field: "ownership_percent",
      message: "must be a number in (0, 100] with at most 2 decimals",
    });
  }
  if (errors.length) return validationError(requestId, errors);

  const { data: ent, error: selErr } = await scopeToPartner(
    db.schema("core").from("entity").select(ENTITY_COLS).eq("id", entityId),
    ctx,
  ).maybeSingle();
  if (selErr) return internalErrorResponse(requestId, selErr);
  if (!ent) return notFoundResponse(requestId, "entity", entityId);

  const row = ent as Record<string, unknown>;
  if (row.type !== "business" && row.type !== "trust") {
    return apiError(409, "invalid_state", requestId, {
      title: "Invalid State",
      detail: `beneficial owners apply to business/trust entities; ${entityId} is a ${row.type}`,
    });
  }

  const owners = Array.isArray(row.owners) ? [...row.owners as unknown[]] : [];
  owners.push({ entity_id: body.owner_entity_id, percent });
  const { data: updated, error: updErr } = await db.schema("core").from("entity")
    .update({ owners }).eq("id", entityId).select(ENTITY_COLS).single();
  if (updErr) return internalErrorResponse(requestId, updErr);

  await emitEntityEvent(db, "entity.owner.added", "entity", entityId, {
    owner_entity_id: body.owner_entity_id,
    percent,
  });
  return jsonResponse(entityResponse(updated as Record<string, unknown>), 200, requestId);
}
