// The UI's data layer — real records from the banking core.
//
// Replaces the hand-written fixtures this app shipped with. Every call goes to
// /api/core/*, the server-side proxy that holds the API key (lib/coreApi.js);
// nothing here talks to Supabase directly, and nothing here sees a credential.
//
// The proxy is READ-only, so this module has no create/update functions. The
// teller's transaction form is still a stub for that reason, and says so where
// it is rendered rather than pretending a write happened.

async function get(path, params = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
  );
  const res = await fetch(`/api/core/${path}${qs.toString() ? `?${qs}` : ""}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // The core API's error envelope carries `detail`; surface it rather than a
    // bare status, because the useful cases (405 before the function is
    // deployed, 503 with no key configured) are diagnosable only from it.
    //
    // A 400 is shaped differently: type "validation_error" with a per-field
    // `errors` array and no `detail` at all. Flattened here, because "request
    // failed (400)" hides the one thing the response was written to say —
    // which field was wrong, e.g. business_date is required on cash/aggregation.
    const fields = Array.isArray(body?.errors)
      ? body.errors.map((e) => [e.field, e.message].filter(Boolean).join(" ")).join("; ")
      : "";
    throw new Error(
      body?.detail || body?.title || fields || `request failed (${res.status})`,
    );
  }
  return body;
}

/**
 * Every page of a cursor-paginated list, not just the first.
 *
 * `limit` is a page size, not a result count — a caller that passes limit=200
 * and stops gets the first 200 rows and no indication that more exist. That is
 * survivable for a preview table and fatal for a search: "no member found" and
 * "that member is on page 2" render identically, and the operator cannot tell
 * which one they are looking at.
 *
 * `cap` exists so a pagination bug upstream cannot spin here forever. Hitting
 * it means the result is truncated, so callers that must not lie about
 * completeness should check `hitCap` rather than assume they saw everything.
 */
async function getAll(path, params = {}, { pageSize = 200, cap = 5000 } = {}) {
  const rows = [];
  let after;
  let hitCap = false;

  for (;;) {
    const body = await get(path, { ...params, limit: pageSize, after });
    rows.push(...(body.data ?? []));

    if (rows.length >= cap) {
      hitCap = true;
      break;
    }
    if (!body.pagination?.has_more) break;

    // No cursor despite has_more would loop on the same page forever.
    if (!body.pagination.next_after) break;
    after = body.pagination.next_after;
  }

  rows.hitCap = hitCap;
  return rows;
}

// ---------------------------------------------------------------- formatting

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * Cents -> "$1,234.56".
 *
 * The core serializes money as integer minor units and never as a float — the
 * division to a display string belongs here, at the last possible moment, and
 * nowhere upstream of it.
 */
export function formatCents(cents, { signed = false } = {}) {
  if (typeof cents !== "number") return "—";
  // The abs exists ONLY so the signed branch can hand-prefix +/-. It must not
  // touch the unsigned path: Intl renders a negative on its own, and eating it
  // here once showed a $50M debit-heavy Blnk net as a positive figure.
  if (!signed) return USD.format(cents / 100);
  const text = USD.format(Math.abs(cents) / 100);
  return cents < 0 ? `-${text}` : `+${text}`;
}

/** ISO timestamp -> "Today, 2:34 PM" / "Yesterday" / "Jul 3, 2026". */
export function formatWhen(iso) {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(new Date()) - startOfDay(at)) / 86_400_000);

  if (days === 0) {
    return `Today, ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  if (days === 1) return "Yesterday";
  return at.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

// ------------------------------------------------------------------- members

function toMember(entity) {
  return {
    id: entity.id,
    name: entity.name,
    email: entity.email,
    // core.entity holds no phone number. Left null rather than filled with a
    // placeholder, so the field renders as absent instead of as wrong.
    phone: null,
    joinDate: entity.created_at,
    status: entity.status,
    type: entity.type,
  };
}

export async function fetchMembers({ limit = 50, type } = {}) {
  const body = await get("entities", { limit, type });
  return body.data.map(toMember);
}

export async function fetchMember(memberId) {
  return toMember(await get(`entities/${memberId}`));
}

/**
 * Everything the core will say about one member, for the profile view.
 *
 * Returns the raw entity alongside the mapped member, deliberately. toMember()
 * keeps the seven fields a list row needs and drops the rest; a profile page is
 * the one place that wants date_of_birth, tin, jurisdiction, address and
 * owners, and re-fetching to get them would be the same request twice.
 *
 * Accounts and their transfers are best-effort. A member with no accounts is
 * ordinary — 185 of 200 accounts in this instance carry no entity_id at all,
 * so an unlinked member is the common case here, not an error state. Failing
 * the whole profile because the transfer walk failed would hide the identity
 * fields that did load.
 */
/**
 * KYC posture from the verification history. The newest row decides (the
 * handler orders newest-first); OFAC rides separately because the always-on
 * floor can deny before any provider runs, and a teller reading "denied"
 * needs to know which kind of denied.
 *
 * `rows === null` means the fetch itself failed and renders as "unavailable" —
 * distinct from an empty history, because "we could not check" and "nothing
 * was ever run" call for different conversations at the window.
 */
function toKycSummary(rows) {
  if (rows === null) return { status: "unavailable", count: 0 };
  if (rows.length === 0) return { status: "none", count: 0 };
  const latest = rows[0];
  return {
    status: latest.status, // "approved" | "denied"
    ofac: latest.ofac_result, // "clear" | "hit"
    provider: latest.provider ?? null,
    when: latest.created_at ?? null,
    count: rows.length,
  };
}

export async function fetchMemberProfile(memberId) {
  const entity = await get(`entities/${memberId}`);
  const accounts = await getAll("accounts", { entity_id: memberId }).catch(() => []);
  // Not getAll: the endpoint returns the full history in one body (no
  // pagination envelope), newest first.
  const verifications = await get(`entities/${memberId}/verifications`)
    .then((b) => b.verifications ?? [])
    .catch(() => null);

  // Counterparties here are labelled by account id without the full table
  // walk: the profile already knows whose page it is, and the other side of a
  // member's transfer is almost surely one of the 1,794 holderless accounts.
  const acctTable = new Map(accounts.map((a) => [a.id, { label: a.id, entityId: null }]));
  const perAccount = await Promise.all(
    accounts.map((a) =>
      get("transfers", { account_id: a.id, limit: 50 })
        .then((b) => (b.data ?? []).map((t) => toTransaction(t, { acctTable, accountId: a.id })))
        .catch(() => []),
    ),
  );

  // Kept PER ACCOUNT as well as flat: an on-us transfer between two of this
  // member's accounts is one row with two points of view — a debit under the
  // sending account and a credit under the receiving one. A deduped flat list
  // carries only whichever side arrived first, so any per-account rendering
  // must read its own side from here, not filter the flat list.
  const transactionsByAccount = Object.fromEntries(
    accounts.map((a, i) => [a.id, perAccount[i]]),
  );

  // One transfer touching two of this member's accounts arrives twice, once
  // per side. Deduped on id so the profile does not double-count it.
  const seen = new Set();
  const transactions = perAccount.flat().filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  return {
    member: toMember(entity),
    entity,
    accounts: accounts.map((a) => toAccount(a, new Map([[entity.id, entity.name]]))),
    transactions,
    transactionsByAccount,
    kyc: toKycSummary(verifications),
  };
}

/**
 * One box, every road to a member. Client-side, because the core API has no
 * search endpoint; every entity is read, not the first page.
 *
 * What a term can be, tried in this order:
 *
 *   - tr_…      a transfer id. GET /transfers/{id}, then the holder of either
 *               side. A teller holding a transaction id is usually trying to
 *               find the person behind it — this is the road there.
 *   - a name    tokens, matched independently: "smith", "jane smith" and
 *               "smith jane" all work, because every token must appear in the
 *               name but in no particular order. Also matched against email.
 *   - ent_…     a member id, whole or fragment.
 *   - acct_…    an account id, whole or fragment, resolved acct -> entity_id
 *               -> member. Runs when nothing above matched: an account number
 *               is a property of an account, not of its holder.
 *
 * Returns members only, and only real ones — a transfer or account whose
 * holder is unlinked in the core resolves to nothing rather than to a fake
 * result row. In this instance that is common: 1,794 of 1,829 accounts carry
 * no entity_id at all.
 */
export async function searchMembers(term) {
  const raw = term.trim();
  const needle = raw.toLowerCase();
  if (!needle) return [];

  const members = (await getAll("entities")).map(toMember);

  // A transfer id is exact — a fragment of one matches nothing, by design:
  // hex fragments collide, and a wrong member presented confidently is worse
  // than no result.
  if (needle.startsWith("tr_")) {
    try {
      const [transfer, table] = await Promise.all([get(`transfers/${raw}`), accountTable()]);
      const sides = [transfer.originator?.account_id, transfer.beneficiary?.account_id];
      const holderIds = new Set(
        sides.map((id) => (id ? table.get(id)?.entityId : null)).filter(Boolean),
      );
      return members.filter((m) => holderIds.has(m.id));
    } catch {
      return [];
    }
  }

  const tokens = needle.split(/\s+/).filter(Boolean);
  const direct = members.filter((m) => {
    const name = (m.name ?? "").toLowerCase();
    const email = (m.email ?? "").toLowerCase();
    return (
      tokens.every((t) => name.includes(t)) ||
      tokens.every((t) => email.includes(t)) ||
      m.id.toLowerCase().includes(needle)
    );
  });
  if (direct.length > 0) return direct;

  const table = await accountTable();
  const holders = new Set();
  for (const [acctId, info] of table) {
    if (info.entityId && acctId.toLowerCase().includes(needle)) holders.add(info.entityId);
  }
  return members.filter((m) => holders.has(m.id));
}

// ------------------------------------------------------------------ accounts

function toAccount(account, nameByEntityId) {
  return {
    id: account.id,
    // core.account has no name column — an account is identified by its holder.
    // Falling back to the id rather than inventing a label keeps an unlinked
    // account visibly unlinked instead of looking like a named product.
    name: nameByEntityId?.get(account.entity_id) ?? account.id,
    balance: formatCents(account.balance),
    balanceCents: account.balance,
    type: account.account_type,
    status: account.status,
    entityId: account.entity_id,
  };
}

/**
 * Accounts, with holder names resolved.
 *
 * Two requests rather than one: the core API exposes no join, so the holder
 * name comes from entities matched on entity_id. The fallback to the account's
 * own id is still here and still correct for a genuinely unlinked account —
 * but it was firing constantly for a reason that had nothing to do with
 * linkage. The lookup read one page of 200 entities against 314, so only 15 of
 * 200 accounts found their holder and the other 185 rendered as acct_ ids.
 * Reading every entity turns the fallback back into the rare case it describes.
 */
export async function fetchAccounts({ limit = 50, entityId, status } = {}) {
  const [accountsBody, members] = await Promise.all([
    get("accounts", { limit, entity_id: entityId, status }),
    getAll("entities")
      .then((rows) => rows.map(toMember))
      .catch(() => []),
  ]);
  const nameByEntityId = new Map(members.map((m) => [m.id, m.name]));
  return accountsBody.data.map((a) => toAccount(a, nameByEntityId));
}

export async function fetchAccount(accountId) {
  return toAccount(await get(`accounts/${accountId}`), null);
}

/**
 * Everything the core will say about one account, for its detail page.
 *
 * The raw row rides along for the fields toAccount() drops (created_at,
 * balance_synced_at) — a detail page is the one place that wants them.
 *
 * The holder comes from the account TABLE, not the detail row: GET
 * /accounts/{id} omits entity_id entirely (its select simply lacks the
 * column — see accounts.ts:291), so trusting it would report every account
 * as holderless, including the 35 that are not. `undefined` there means
 * "the endpoint didn't say", which is not the same fact as null's "no
 * holder", and conflating the two is how a page ends up asserting a data
 * condition the data does not have.
 */
export async function fetchAccountProfile(accountId) {
  const raw = await get(`accounts/${accountId}`);
  const [table, transactions] = await Promise.all([
    accountTable().catch(() => new Map()),
    fetchAccountTransactions(accountId).catch(() => []),
  ]);
  const entityId = raw.entity_id ?? table.get(accountId)?.entityId ?? null;
  const holder = entityId ? await fetchMember(entityId).catch(() => null) : null;
  return { raw, account: toAccount(raw, null), holder, transactions };
}

// -------------------------------------------------------------- transactions

const TRANSFER_STATUS_LABEL = {
  pending_approval: "pending",
  submitted: "pending",
  settled: "completed",
  returned: "returned",
  rejected: "rejected",
  canceled: "canceled",
};

/**
 * A transfer, seen from `accountId` if one is given.
 *
 * Sign is a point of view, not a property of the row: the same transfer is a
 * debit to its originator and a credit to its beneficiary. With no account in
 * hand there is NO point of view to sign from, so the amount renders unsigned
 * — the alternative (defaulting every row to the originator's side) painted
 * the teller journal and the dashboard as a wall of negatives, deposits
 * included.
 */
function toTransaction(transfer, { acctTable, accountId } = {}) {
  const fromId = transfer.originator?.account_id;
  const toId = transfer.beneficiary?.account_id;
  const isCredit = accountId ? toId === accountId : false;
  const counterpartyId = isCredit ? fromId : toId;
  const counterparty = counterpartyId ? acctTable?.get(counterpartyId) : null;

  return {
    id: transfer.id,
    member: counterparty?.label ?? counterpartyId ?? "—",
    // Null unless the counterparty account names a real, known holder. The
    // journal uses this to decide whether the member cell links to a member
    // profile; an id shown because no holder exists must not pretend to be one.
    memberEntityId: counterparty?.entityId ?? null,
    // The counterparty's account id, for linking to the account page when no
    // holder exists — the id itself is still a road somewhere real.
    counterpartyAccountId: counterpartyId ?? null,
    type: "Transfer",
    category: "Transfer",
    amount: accountId
      ? formatCents(isCredit ? transfer.amount_cents : -transfer.amount_cents, { signed: true })
      : formatCents(transfer.amount_cents),
    amountCents: transfer.amount_cents,
    date: formatWhen(transfer.created_at),
    // The raw timestamp, because the pretty string cannot be filtered on.
    createdAt: transfer.created_at ?? null,
    status: TRANSFER_STATUS_LABEL[transfer.status] ?? transfer.status,
    fromAccountId: fromId,
    toAccountId: toId,
  };
}

/**
 * Every account, holder resolved to BOTH a display label and an entity id.
 * The lookup table behind the two-hop walk transfer -> account -> entity,
 * kept whole rather than sampled: a partial table does not fail loudly, it
 * silently relabels rows with ids.
 *
 * entityId rides along so a caller can render the label as a link to the
 * holder's profile. It is null for the unlinked case — in this instance the
 * overwhelming one (1,794 of 1,829 accounts carry no entity_id) — and a null
 * here must stay null downstream: an unlinked account has no profile to open,
 * and a link to nowhere is the dead-button problem wearing a new hat.
 *
 * Cached for the life of the page. The walk is ~10 requests; a journal that
 * re-ran it per render would hammer the core to re-learn a table that does
 * not change under a teller's feet. Navigation (or refresh) naturally evicts.
 */
let acctTablePromise = null;
function accountTable() {
  if (acctTablePromise) return acctTablePromise;
  acctTablePromise = (async () => {
    const [accounts, entities] = await Promise.all([
      getAll("accounts"),
      getAll("entities").catch(() => []),
    ]);
    const nameByEntityId = new Map(entities.map((e) => [e.id, e.name]));
    return new Map(
      accounts.map((a) => [
        a.id,
        {
          label: (a.entity_id && nameByEntityId.get(a.entity_id)) || a.id,
          entityId: a.entity_id && nameByEntityId.has(a.entity_id) ? a.entity_id : null,
        },
      ]),
    );
  })();
  // A failed walk must not poison every later call with the same rejection.
  acctTablePromise.catch(() => {
    acctTablePromise = null;
  });
  return acctTablePromise;
}

/**
 * Transfers, with the counterparty resolved to a holder name where possible.
 *
 * Three requests, because naming the other side of a transfer is a two-hop walk
 * the API cannot do in one call: transfer -> account -> entity. Both hops now
 * read every page; when they read only the first, the journal showed a column
 * of acct_ ids where member names belong. A counterparty genuinely absent from
 * the core still falls back to its account id.
 */
export async function fetchTransactions({ limit = 50, accountId, status, all = false } = {}) {
  const [rows, acctTable] = await Promise.all([
    all
      ? getAll("transfers", { account_id: accountId, status })
      : get("transfers", { limit, account_id: accountId, status }).then((b) => b.data ?? []),
    accountTable().catch(() => new Map()),
  ]);
  return rows.map((t) => toTransaction(t, { acctTable, accountId }));
}

export function fetchAccountTransactions(accountId, opts = {}) {
  return fetchTransactions({ ...opts, accountId });
}

// ---------------------------------------------------------------- accounting

/**
 * The member ledger, summed. Every account, not a page — a subtotal built from
 * the first 200 rows would be a figure that looks like a position and isn't.
 * `truncated` is the cap flag from getAll surfaced so the page can say "at
 * least" instead of presenting a floor as a total.
 */
export async function fetchLedgerSummary() {
  return summarizeAccounts(await getAll("accounts"));
}

/**
 * The ledger summary, from account rows the caller already has.
 *
 * Split out from the fetch because the accounting page needs BOTH this summary
 * and the raw rows (for the bln_ -> acct_ map the general ledger names its
 * accounts with). Calling two functions that each walked all 1,829 accounts
 * meant the page paid for the walk twice — four times under React StrictMode —
 * for one set of rows that had not changed in between.
 */
export function summarizeAccounts(accounts) {
  const byType = new Map();
  let totalCents = 0;
  for (const a of accounts) {
    const cents = typeof a.balance === "number" ? a.balance : 0;
    totalCents += cents;
    const key = a.account_type ?? "unknown";
    const row = byType.get(key) ?? { type: key, count: 0, open: 0, balanceCents: 0 };
    row.count += 1;
    if (a.status === "open") row.open += 1;
    row.balanceCents += cents;
    byType.set(key, row);
  }

  return {
    totalCents,
    accountCount: accounts.length,
    truncated: Boolean(accounts.hitCap),
    byType: [...byType.values()].sort((x, y) => y.balanceCents - x.balanceCents),
  };
}

/**
 * Transfer volume by the core's own status vocabulary, deliberately not the
 * display labels the teller journal uses: pending_approval and submitted are
 * different states of money (one is held by policy, one is in flight) and an
 * accounting view is exactly the place that difference matters.
 */
export async function fetchTransferSummary() {
  const transfers = await getAll("transfers");

  const byStatus = new Map();
  for (const t of transfers) {
    const key = t.status ?? "unknown";
    const row = byStatus.get(key) ?? { status: key, count: 0, amountCents: 0 };
    row.count += 1;
    row.amountCents += typeof t.amount_cents === "number" ? t.amount_cents : 0;
    byStatus.set(key, row);
  }

  return {
    transferCount: transfers.length,
    truncated: Boolean(transfers.hitCap),
    byStatus: [...byStatus.values()].sort((x, y) => y.amountCents - x.amountCents),
  };
}

// ----------------------------------------------------------------- admin

/**
 * One cheap read against every path the proxy allows, timed.
 *
 * This is the admin page's "is the core actually there" panel. Each probe asks
 * for as little as the endpoint will serve (limit=1 where a limit exists), and
 * a failure carries the endpoint's own error text — a 503 with "key unset" and
 * a 400 with "business_date required" are different problems and the page
 * should not flatten them into a red dot.
 */
export async function probeCoreEndpoints() {
  const today = new Date().toISOString().slice(0, 10);
  const probes = [
    { name: "Entities", path: "entities", params: { limit: 1 } },
    { name: "Accounts", path: "accounts", params: { limit: 1 } },
    { name: "Transfers", path: "transfers", params: { limit: 1 } },
    { name: "Control results", path: "control-results", params: { limit: 1 } },
    { name: "Governance obligations", path: "governance/obligations" },
    { name: "Pending approvals (EPS)", path: "eps/pending-approvals" },
    { name: "Cash aggregation", path: "cash/aggregation", params: { business_date: today } },
    { name: "Call report (5300)", path: "reports/5300" },
  ];

  return Promise.all(
    probes.map(async ({ name, path, params }) => {
      const started = Date.now();
      try {
        await get(path, params ?? {});
        return { name, path, ok: true, ms: Date.now() - started, error: null };
      } catch (e) {
        return { name, path, ok: false, ms: Date.now() - started, error: e.message };
      }
    }),
  );
}

/**
 * How much data the core is holding, counted by walking every page.
 *
 * Three full walks is not free, but a count taken from one page is not a
 * count. Each figure carries its own truncation flag for the same reason
 * fetchLedgerSummary does.
 */
export async function fetchCoreInventory() {
  const [entities, accounts, transfers] = await Promise.all([
    getAll("entities"),
    getAll("accounts"),
    getAll("transfers"),
  ]);
  const shape = (rows) => ({ count: rows.length, truncated: Boolean(rows.hitCap) });
  return {
    entities: shape(entities),
    accounts: shape(accounts),
    transfers: shape(transfers),
  };
}

// ------------------------------------------------------------ control results

/**
 * Control evidence, newest first.
 *
 * The only endpoint here with a real cursor: `next_after` is the created_at of
 * the page's last row and the core filters strictly older, so paging forward
 * cannot serve a row twice. Passed straight through rather than folded into a
 * page number, because that is the only token the core accepts.
 *
 * Rows are returned unmapped. `score` is nullable in core.control_result and a
 * null there means "this control does not score", not zero — the distinction
 * survives only if nothing in this layer defaults it.
 */
export async function fetchControlResults({
  control_id,
  decision,
  subject_ref,
  event,
  limit = 50,
  after,
} = {}) {
  const body = await get("control-results", {
    control_id,
    decision,
    subject_ref,
    event,
    limit,
    after,
  });
  return {
    results: body.data ?? [],
    limit: body.pagination?.limit ?? limit,
    hasMore: Boolean(body.pagination?.has_more),
    nextAfter: body.pagination?.next_after ?? null,
  };
}

/**
 * The gate decisions worth a reviewer's attention — everything the money-movement
 * gate did NOT let pass. The endpoint filters one decision at a time, so this
 * fans out per flag decision and merges the results newest-first. `pass`/`clear`
 * are excluded on purpose: a queue of things that were fine is not a queue.
 */
export const GATE_FLAG_DECISIONS = ["reject", "block", "hold"];

export async function fetchComplianceFlags({ perDecision = 50 } = {}) {
  const batches = await Promise.all(
    GATE_FLAG_DECISIONS.map((decision) =>
      fetchControlResults({ decision, limit: perDecision })
        .then((r) => r.results)
        .catch(() => []),
    ),
  );
  const flags = batches.flat();
  flags.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return flags;
}

// --------------------------------------------------------------- obligations

/**
 * The governance calendar's hard ceiling. The endpoint takes no limit param and
 * no cursor: it returns at most this many rows and says nothing about whether
 * there were more. A caller that renders `total` without this number cannot
 * tell a 500-obligation register from a truncated one.
 */
export const OBLIGATIONS_CAP = 500;

/**
 * Every obligation, ordered by next_due_at ascending.
 *
 * `scheduled`/`unscheduled` are the core's own counts, split on anchor_date:
 * an obligation with no anchor has next_due_at null and therefore no position
 * in the calendar at all. Kept as its own bucket rather than sorted to one end.
 */
export async function fetchObligations() {
  const body = await get("governance/obligations");
  return {
    obligations: body.obligations ?? [],
    total: body.total ?? 0,
    scheduled: body.scheduled ?? 0,
    unscheduled: body.unscheduled ?? 0,
  };
}

// ---------------------------------------------------------- dual-control (EPS)

/** Per-list ceiling on GET /eps/pending-approvals. Same blindness as above. */
export const APPROVALS_CAP = 200;

/**
 * The dual-control queue, and separately the payments nobody assessed.
 *
 * Two lists, never merged. `pending` is a payment_approval row awaiting a
 * second pair of eyes. `unassessed` is a payment for which no client limit was
 * configured, so it was neither held for approval nor found exempt — a gap in
 * the policy, not an item in a queue. The core's `warning` states that; it is
 * passed through verbatim rather than restated.
 */
export async function fetchPendingApprovals() {
  const body = await get("eps/pending-approvals");
  return {
    pending: body.pending ?? [],
    pendingCount: body.pending_count ?? 0,
    unassessed: body.unassessed ?? [],
    unassessedCount: body.unassessed_count ?? 0,
    warning: body.warning ?? null,
  };
}

// ---------------------------------------------------------------------- cash

/**
 * One business day of cash, aggregated per person.
 *
 * `businessDate` is required — the core 400s without it rather than defaulting
 * to today, so there is no such thing as "the current day" here.
 *
 * Two requests, for the same reason fetchAccounts makes two: the response
 * identifies people by entity_id only, and the API exposes no join. Every
 * entity is read, not the first page — this list names the people a CTR would
 * be filed on, and an unresolved name here is a bare entity_id on a currency
 * transaction report.
 *
 * Amounts are integer cents, and cash_in/cash_out are deliberately not summed:
 * the CTR threshold is assessed against each direction separately.
 */
export async function fetchCashAggregation(businessDate) {
  const [body, members] = await Promise.all([
    get("cash/aggregation", { business_date: businessDate }),
    getAll("entities")
      .then((rows) => rows.map(toMember))
      .catch(() => []),
  ]);
  const nameByEntityId = new Map(members.map((m) => [m.id, m.name]));

  return {
    businessDate: body.business_date,
    // false => the per-person totals below are a LOWER BOUND
    complete: Boolean(body.complete),
    people: (body.people ?? []).map((p) => ({
      entityId: p.entity_id,
      name: nameByEntityId.get(p.entity_id) ?? null,
      cashIn: p.cash_in,
      cashOut: p.cash_out,
      transactionCount: p.transaction_count,
      ctrRequired: Boolean(p.ctr_required),
    })),
    unattributable: {
      transactionCount: body.unattributable?.transaction_count ?? 0,
      cashIn: body.unattributable?.cash_in ?? 0,
      cashOut: body.unattributable?.cash_out ?? 0,
      transactionIds: body.unattributable?.transaction_ids ?? [],
    },
    warning: body.warning ?? null,
  };
}

// ------------------------------------------------------------- 5300 report

/**
 * The NCUA 5300 operator view.
 *
 * Returns two things that are NOT the same clock, and the caller has to keep
 * them apart:
 *
 *   - `current` is live, and exact at the moment of the read: the FBO position
 *     is a VIEW over open member share balances (migration 20260817000100),
 *     not a figure a consumer advances. `last_seq` alongside it is the core's
 *     ingest sequence (aggregator.event.sequence_id) — kept because a derived
 *     position cannot answer "did anything happen?" on its own: a deposit and
 *     an equal withdrawal leave the sum untouched.
 *   - `history` is a daily snapshot table written by a scheduled job. Its
 *     newest row can be a day old, and `stale` says whether today's run has
 *     landed at all.
 *
 * Both are passed through unflattened. Collapsing them into one "current
 * position" would show an operator a figure that stops moving at midnight with
 * nothing on screen explaining why.
 */
export async function fetchReport5300() {
  const body = await get("reports/5300");
  return {
    instanceId: body.instance_id,
    current: body.current ?? null,
    history: body.history ?? [],
    asOf: body.as_of ?? null,
    stale: Boolean(body.stale),
    cadence: body.cadence ?? null,
    chartOfAccountsNote: body.chart_of_accounts_note ?? null,
    // The FBO tie-out, already scoped by the core to THIS instance's partner
    // program. Taken from the response rather than re-summed here on purpose:
    // the browser sees whatever accounts its actor may list — for an ops actor
    // that is every partner — so summing client-side compares one program's
    // position against everybody's balances.
    memberShareCents: body.member_share_cents ?? null,
    fboDiffCents: body.fbo_reconciliation_diff_cents ?? null,
  };
}

/**
 * Raw account rows, every page.
 *
 * Unmapped on purpose: the general-ledger view needs `blnk_balance_id`, which
 * is how a Blnk balance (bln_…) is tied back to the account a human recognises
 * (acct_…). toAccount() drops it, and a GL that can only name its accounts by
 * opaque ledger ids is a GL nobody will read.
 */
export async function fetchRawAccounts() {
  return getAll("accounts");
}

// ------------------------------------------------- compliance dashboard
//
// The monitoring surface's data, the same shapes the standalone dashboard
// reads. The four GET endpoints go through the read proxy (they are
// x-ui-surface: true in the spec); the manifest is a static build artifact
// (not an endpoint) served from public/; flagging is the one write, through
// its own single-purpose route (see below and pages/api/compliance/flag.js).

/**
 * The control catalogue — policy -> controls, watch codes, citations, test
 * verdicts, and the policy prose the dashboard renders in place. A static
 * artifact generated by scripts/build_dashboard.py from controls.json and
 * copied into public/, so it is fetched directly, not via the core proxy.
 */
export async function fetchDashboardManifest() {
  const res = await fetch("/compliance-manifest.json", { cache: "no-cache" });
  if (!res.ok) throw new Error(`compliance manifest ${res.status}`);
  return res.json();
}

/** Live evidence aggregates (control activity, open BSA alerts, ops health), by evidence origin. */
export function fetchDashboardData(provenance = "all") {
  return get("compliance/dashboard/data", { provenance });
}

/**
 * The heartbeat — every watched code and gate control, bucketed over time.
 *
 * `slim` sends ?last_seen=0 to skip the all-time census (~80KB) on refresh
 * polls; the model keeps the census from the first, non-slim load. `last_seen`
 * is 0 (a real value the proxy forwards) only when slim, undefined otherwise so
 * get() drops it and the core returns the full census.
 */
export function fetchDashboardHeartbeat({ hours = 168, bucket = 21600, slim = false } = {}) {
  return get("compliance/dashboard/heartbeat", { hours, bucket, last_seen: slim ? 0 : undefined });
}

/** One control's raw event stream, newest first. `before` is the created_at cursor from next_before. */
export function fetchDashboardEvents({ codes, limit = 50, before } = {}) {
  return get("compliance/dashboard/events", { codes: (codes ?? []).join(","), limit, before });
}

/** The full transaction cycle (events + gate decisions) of one resource. */
export function fetchDashboardTrace(resourceId) {
  return get(`compliance/dashboard/trace/${encodeURIComponent(resourceId)}`);
}

/**
 * Flag a monitored event -> route a real, acknowledgeable escalation.
 *
 * The ONLY write this UI makes. It reaches the core through a single-purpose
 * server route (pages/api/compliance/flag) rather than the read proxy — the
 * read proxy is GET-only by design, and this UI does not open a general write
 * door (POST /transfers moves real money). Demo posture: the escalation lands
 * in the sim/demo evidence scope, exactly as the standalone dashboard's flag.
 */
export async function flagEvent(payload) {
  const res = await fetch("/api/compliance/flag", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const fields = Array.isArray(body?.errors)
      ? body.errors.map((e) => [e.field, e.message].filter(Boolean).join(" ")).join("; ")
      : "";
    throw new Error(body?.detail || body?.title || fields || `flag failed (${res.status})`);
  }
  return body?.data ?? body;
}

/**
 * Everything the Statement of Financial Condition can be built from today.
 *
 * Deliberately returns RAW account rows rather than the toAccount() shape the
 * rest of this module uses: the 5300 buckets shares by `account_type` and has
 * to see `status` to exclude closed accounts, and toAccount() formats the
 * balance to a display string and drops both fields. A display shape is the
 * wrong input to a filing.
 *
 * Every account, not a page. A balance sheet assembled from the first 200 rows
 * of 1,829 is not a balance sheet, and unlike a preview table there is no
 * reading of it that is merely incomplete rather than wrong.
 */
export async function fetch5300Inputs() {
  const [accounts, report] = await Promise.all([
    getAll("accounts"),
    fetchReport5300().catch(() => null),
  ]);

  return {
    accounts,
    truncated: Boolean(accounts.hitCap),
    fboPositionCents: report?.current?.fbo_position_cents ?? null,
    memberShareCents: report?.memberShareCents ?? null,
    fboDiffCents: report?.fboDiffCents ?? null,
    lastSeq: report?.current?.last_seq ?? null,
    updatedAt: report?.current?.updated_at ?? null,
    instanceId: report?.instanceId ?? null,
    history: report?.history ?? [],
    stale: Boolean(report?.stale),
    asOf: report?.asOf ?? null,
    chartOfAccountsNote: report?.chartOfAccountsNote ?? null,
  };
}
