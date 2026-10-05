// In-memory Postgres stand-in for the drill.
//
// THE HONESTY PROBLEM THIS FILE EXISTS TO MANAGE
//
// Several of the strongest guarantees in this repo are CHECK constraints, not
// application code: four-eyes on SAR decisions and payment approvals, the three
// disposal conditions, review-before-issue on an adverse action notice. A naive
// in-memory fake enforces none of them, so a drill running against one would
// report PASS for cases the real database would reject — a drill that proves
// less than it appears to, which is the exact failure shape this project has
// been guarding against everywhere else.
//
// So the constraints below are re-implemented here, and `UNENFORCED` names the
// ones that are NOT. The unenforced list is the one a reader needs; see
// DRILL.md, where it is printed first.

import { pgCompare } from "../_shared/pg_order.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

export interface ConstraintViolation {
  constraint: string;
  table: string;
  detail: string;
}

/**
 * Constraints re-implemented in this fake. Each is a real constraint from a
 * migration; the name matches so a failure here is traceable to the SQL.
 */
const CHECKS: Record<string, (row: Any, table: string) => ConstraintViolation | null> = {
  ck_eps_auth_lockout_stamped: (r, t) =>
    t === "eps_auth_event" && ((r.decision === "locked_out") !== (r.locked_out_at != null))
      ? { constraint: "ck_eps_auth_lockout_stamped", table: t, detail: "lockout decision and timestamp disagree" }
      : null,

  ck_eps_auth_challenge_method: (r, t) =>
    t === "eps_auth_event" && r.decision === "challenged" && r.challenge_method == null
      ? { constraint: "ck_eps_auth_challenge_method", table: t, detail: "challenge with no method" }
      : null,

  ck_eps_pospay_decision_complete: (r, t) =>
    t === "eps_pospay_exception" &&
      [r.decision, r.decided_at, r.decided_by].filter((v) => v != null).length % 3 !== 0
      ? { constraint: "ck_eps_pospay_decision_complete", table: t, detail: "partial pospay decision" }
      : null,

  // The ratio must equal its own components. A capital_position whose stored
  // ratio disagrees with net_worth/total_assets silently poisons every
  // downstream PCA classification, so it is caught structurally.
  ck_capital_ratio_matches_components: (r, t) =>
    t === "capital_position" && r.total_assets_cents > 0 &&
      r.net_worth_ratio_bp !== Math.trunc((r.net_worth_cents * 10000) / r.total_assets_cents)
      ? {
        constraint: "ck_capital_ratio_matches_components",
        table: t,
        detail: `stored ratio ${r.net_worth_ratio_bp}bp != computed from components`,
      }
      : null,

  // A restoration plan can only be due for an institution that is actually
  // undercapitalized.
  ck_capital_nwrp_only_if_under: (r, t) =>
    t === "capital_position" && r.nwrp_due_at != null &&
      !["undercapitalized", "significantly_undercapitalized", "critically_undercapitalized"]
        .includes(String(r.pca_category))
      ? {
        constraint: "ck_capital_nwrp_only_if_under",
        table: t,
        detail: `nwrp due for ${r.pca_category}`,
      }
      : null,

  // CP-03: an unset internal trigger cannot carry a breach verdict either way.
  ck_capital_internal_verdict: (r, t) =>
    t === "capital_position" &&
      ((r.internal_trigger_bp == null) !== (r.internal_trigger_breached == null))
      ? {
        constraint: "ck_capital_internal_verdict",
        table: t,
        detail: "internal trigger and its verdict must be set together",
      }
      : null,

  ck_case_four_eyes: (r, t) =>
    t === "case" && r.decided_by != null && r.decided_by === r.opened_by
      ? { constraint: "ck_case_four_eyes", table: t, detail: "decided_by = opened_by" }
      : null,

  ck_payment_approval_four_eyes: (r, t) =>
    t === "payment_approval" && r.approved_by != null && r.approved_by === r.created_by
      ? { constraint: "ck_payment_approval_four_eyes", table: t, detail: "approved_by = created_by" }
      : null,

  ck_record_disposal_not_held: (r, t) =>
    t === "record" && r.disposed_at != null && r.legal_hold_flag === true
      ? { constraint: "ck_record_disposal_not_held", table: t, detail: "disposed while under legal hold" }
      : null,

  ck_record_disposal_after_expiry: (r, t) =>
    t === "record" && r.disposed_at != null && r.retention_expires_at != null &&
      String(r.disposed_at) < String(r.retention_expires_at)
      ? { constraint: "ck_record_disposal_after_expiry", table: t, detail: "disposed before retention expiry" }
      : null,

  ck_record_disposal_approved: (r, t) =>
    t === "record" && r.disposed_at != null &&
      (r.disposal_approved_by == null || r.disposal_approved_at == null)
      ? { constraint: "ck_record_disposal_approved", table: t, detail: "disposed without approval" }
      : null,

  ck_aan_reviewed_before_issue: (r, t) =>
    t === "adverse_action_notice" && r.issued_at != null &&
      (r.reviewed_by == null || r.reviewed_at == null)
      ? { constraint: "ck_aan_reviewed_before_issue", table: t, detail: "issued without second review" }
      : null,

  ck_wire_dual_control_before_complete: (r, t) =>
    t === "wire_transfer" && r.status === "completed" &&
      !["approved", "not_required"].includes(String(r.dual_control_status))
      ? {
        constraint: "ck_wire_dual_control_before_complete",
        table: t,
        detail: `completed with dual_control_status=${r.dual_control_status}`,
      }
      : null,

  ck_work_item_adverse_rationale: (r, t) =>
    t === "work_item" && r.outcome != null &&
      ["denied", "rejected", "no_action"].includes(String(r.outcome)) && r.outcome_rationale == null
      ? { constraint: "ck_work_item_adverse_rationale", table: t, detail: "adverse outcome with no rationale" }
      : null,

  ck_obligation_due_iff_anchored: (r, t) =>
    t === "obligation" && ((r.anchor_date == null) !== (r.next_due_at == null))
      ? { constraint: "ck_obligation_due_iff_anchored", table: t, detail: "anchor and due date disagree" }
      : null,

  ck_ctr_filed_has_ref: (r, t) =>
    t === "ctr_filing" && r.filed_at != null && (r.filed_by == null || r.fincen_ref == null)
      ? { constraint: "ck_ctr_filed_has_ref", table: t, detail: "filed with no FinCEN reference" }
      : null,

  ck_aan_has_reasons: (r, t) =>
    t === "adverse_action_notice" && (!Array.isArray(r.reasons) || r.reasons.length === 0)
      ? { constraint: "ck_aan_has_reasons", table: t, detail: "notice with no reasons" }
      : null,

  ck_threshold_warn_before_limit: (r, t) => {
    if (t !== "threshold" || r.warn_value == null || r.limit_value == null) return null;
    const ok = r.direction === "below" ? r.warn_value >= r.limit_value : r.warn_value <= r.limit_value;
    return ok ? null : {
      constraint: "ck_threshold_warn_before_limit",
      table: t,
      detail: "warn level on the wrong side of the limit",
    };
  },

  // provenance separation, both directions
  provenance_core: (r, t) =>
    r.provenance === "simulated"
      ? { constraint: `ck_${t}_provenance`, table: t, detail: "'simulated' is not representable in core" }
      : null,
  provenance_sim: (r, t) =>
    r.provenance != null && r.provenance !== "simulated"
      ? { constraint: `ck_sim_${t}_provenance`, table: t, detail: `sim requires 'simulated', got '${r.provenance}'` }
      : null,
};

/**
 * Constraints and behaviours the real database enforces that this fake DOES
 * NOT. Printed FIRST in DRILL.md, because this is the list that changes how a
 * reader should weigh a passing drill.
 */
export const UNENFORCED: { what: string; why_it_matters: string }[] = [
  {
    what: "Foreign keys (fk_cash_transaction_entity, fk_account_entity, fk_loan_party_application, …)",
    why_it_matters:
      "The drill can reference an entity or application id that does not exist and nothing will object. " +
      "Referential integrity is NOT exercised.",
  },
  {
    what: "UNIQUE constraints (uq_ctr_entity_date, uq_payment_approval_resource, uq_aan_application, …)",
    why_it_matters:
      "Duplicate-suppression is modelled only where a writer passes ignoreDuplicates; a genuine unique " +
      "violation would surface in Postgres and not here.",
  },
  {
    what: "The immutability triggers (freeze_provenance, freeze_disposal, freeze_attestation)",
    why_it_matters:
      "The drill cannot prove that provenance is unchangeable, that a disposal cannot be reversed, or " +
      "that an attestation cannot be edited. Those are trigger-enforced and trigger behaviour is not simulated.",
  },
  {
    what: "NOT NULL on partner_id and the FK to core.partner",
    why_it_matters: "An unowned row is representable here and is not in the real schema.",
  },
  {
    what: "Transactionality",
    why_it_matters:
      "Every write here commits independently. A handler that fails halfway leaves partial state in the " +
      "drill where Postgres might roll back, so multi-write atomicity is not proven.",
  },
  {
    what: "Type and range coercion (numeric precision, timestamptz normalisation, enum CHECKs on status columns)",
    why_it_matters:
      "Status vocabularies are enforced by CHECK in the schema but compared as plain strings here, so a " +
      "typo'd status would be caught by Postgres and not by the drill.",
  },
];

export const ENFORCED = Object.keys(CHECKS).filter((k) => !k.startsWith("provenance"));

export interface DrillDb {
  // deno-lint-ignore no-explicit-any
  client: any;
  rows: Record<string, Record<string, Any>[]>;
  violations: ConstraintViolation[];
  reset(): void;
}

/**
 * Column defaults the real schema applies and an in-memory map does not.
 *
 * FOUND BY THE DRILL: without this, every row had created_at === undefined, so
 * runGate's velocity sweep — which filters `created_at >= todayStart` — matched
 * nothing and CG-VEL-01 could never trip. The drill reported a PASS for a
 * transaction that should have been blocked, which is the precise failure mode
 * a low-fidelity fake produces: it proves less than it appears to, silently.
 */
function applyDefaults(row: Any, table: string, now: string): Any {
  const out = { ...row };
  if (out.created_at === undefined) out.created_at = now;
  if (out.updated_at === undefined) out.updated_at = now;
  for (const [col, val] of Object.entries(COLUMN_DEFAULTS[table] ?? {})) {
    if (out[col] === undefined) out[col] = val;
  }
  // FIFTH INSTANCE, and the general form of the previous four. A column that is
  // DECLARED but absent from the insert reads NULL in Postgres — not undefined.
  // The difference is invisible to `if (x)` and lethal to `assertEquals(x, null)`
  // and to `.is("col", null)` filters, so a test can assert the wrong thing and
  // pass. Every declared column now materialises; the ones with defaults got
  // them above, the rest are null.
  for (const col of ALL_COLUMNS[table] ?? []) {
    if (out[col] === undefined) out[col] = null;
  }
  return out;
}

/**
 * NON-TIMESTAMP column defaults, DERIVED FROM THE MIGRATIONS at load time.
 *
 * THIS IS THE FOURTH-INSTANCE GUARD. The same gap has now cost three separate
 * sessions: `created_at` (CG-VEL-01 could not fire at all and the drill
 * reported PASS), `.lt()` on the sweep, and `book_value_cents` reading
 * `undefined` where Postgres gives `0`. Each was patched one column at a time
 * as it was discovered, which guarantees a next one — the double falls behind
 * silently and nothing about its numbers changes when it does.
 *
 * So the defaults are no longer written down here. They are PARSED out of
 * `supabase/migrations/*.sql`, which means a column added to the schema with a
 * default is modelled the moment the migration exists, without anyone
 * remembering to mirror it.
 *
 * Deliberately NOT derived: anything whose default is a function call
 * (`now()`, `gen_random_uuid()`) or an expression. Those are not constants and
 * pretending they are would be a different lie; `now()` is already special-cased
 * above. If the parser cannot read the migrations at all (no fs permission) it
 * yields an empty map and the double behaves exactly as it did before — the
 * guard degrades to the old behaviour rather than throwing in an unrelated test.
 */
function parseColumnDefaults(): Record<string, Record<string, Any>> {
  const out: Record<string, Record<string, Any>> = {};
  let files: string[];
  const dir = new URL("../../migrations/", import.meta.url);
  try {
    files = [...Deno.readDirSync(dir)]
      .filter((e) => e.isFile && e.name.endsWith(".sql"))
      .map((e) => e.name).sort();
  } catch {
    return out; // no read permission — degrade, do not throw
  }

  // `create table if not exists "core"."x" ( ... );` — only core, because sim
  // mirrors are `like ... including all` and inherit whatever core declares.
  const tableRe =
    /create table if not exists\s+"core"\."([a-z_]+)"\s*\(([\s\S]*?)\n\);/g;
  // `"col" <type> [not null] default <literal>` — the value is captured as a
  // BOUNDED token (quoted string, number, boolean, or function call) rather
  // than "everything up to the next comma". A trailing inline `check (...)`
  // contains no comma, so the greedy form swallowed it and every column
  // declared `default 0 check (...)` silently produced no default at all —
  // which is how `book_value_cents` got missed on the first pass of this very
  // parser.
  const colRe =
    /^\s*"([a-z_0-9]+)"\s+[a-z0-9_ \[\]()]+?\s+(?:not null\s+)?default\s+('[^']*'|-?\d+(?:\.\d+)?|true|false|[a-z_]+\([^)]*\))/gim;

  for (const name of files) {
    let sql: string;
    try {
      sql = Deno.readTextFileSync(new URL(name, dir));
    } catch {
      continue;
    }
    for (const t of sql.matchAll(tableRe)) {
      const table = t[1];
      const body = t[2];
      for (const c of body.matchAll(colRe)) {
        const col = c[1];
        const lit = c[2].trim().replace(/\s+$/, "");
        const val = literal(lit);
        if (val === undefined) continue; // function call or expression
        (out[table] ??= {})[col] = val;
      }
    }
  }
  return out;
}

/** A SQL default that is genuinely a constant, or `undefined` if it is not. */
function literal(lit: string): Any {
  const s = lit.replace(/::[a-z_ ]+(\[\])?$/i, "").trim();
  if (/^'([^']*)'$/.test(s)) return s.slice(1, -1);
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  return undefined;
}

const COLUMN_DEFAULTS: Record<string, Record<string, Any>> = parseColumnDefaults();

/**
 * EVERY declared column per table, defaults or not — see the fifth-instance
 * note in `applyDefaults`. Parsed from the same migrations, including
 * `alter table ... add column`, because half this schema arrived that way.
 */
function parseAllColumns(): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  const dir = new URL("../../migrations/", import.meta.url);
  let files: string[];
  try {
    files = [...Deno.readDirSync(dir)]
      .filter((e) => e.isFile && e.name.endsWith(".sql"))
      .map((e) => e.name).sort();
  } catch {
    return {};
  }
  const tableRe = /create table if not exists\s+"core"\."([a-z_0-9]+)"\s*\(([\s\S]*?)\n\);/g;
  // a column line starts with a quoted name; `constraint`/`check`/`primary` do not
  const colRe = /^\s{2}"([a-z_0-9]+)"\s+[a-z]/gim;
  const alterRe =
    /alter table\s+"core"\."([a-z_0-9]+)"([\s\S]*?);/g;
  const addRe = /add column if not exists\s+"([a-z_0-9]+)"/gi;
  // SIXTH INSTANCE. `rename column` was invisible to this parser, so a renamed
  // column kept BOTH names here: the old one materialised as null on every row
  // (see applyDefaults) while the new one — the one the writer actually sets —
  // was absent from the declared set. That is the fake claiming a column the
  // database no longer has, which is the same class of silent drift the
  // parser was written to end. Renames are applied in file order, so a column
  // renamed twice ends up under its final name.
  const renameRe = /rename column\s+"([a-z_0-9]+)"\s+to\s+"([a-z_0-9]+)"/gi;

  for (const name of files) {
    let sql: string;
    try {
      sql = Deno.readTextFileSync(new URL(name, dir));
    } catch {
      continue;
    }
    for (const t of sql.matchAll(tableRe)) {
      const set = (out[t[1]] ??= new Set());
      for (const c of t[2].matchAll(colRe)) set.add(c[1]);
    }
    for (const a of sql.matchAll(alterRe)) {
      const set = (out[a[1]] ??= new Set());
      for (const c of a[2].matchAll(addRe)) set.add(c[1]);
      for (const r of a[2].matchAll(renameRe)) {
        set.delete(r[1]);
        set.add(r[2]);
      }
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v]]));
}

const ALL_COLUMNS: Record<string, string[]> = parseAllColumns();
/**
 * Wraps a builder so that ANY method the real PostgREST client supports but
 * this double does not throws loudly instead of returning undefined.
 *
 * THIS EXISTS BECAUSE THE DOUBLE HAS BEEN WRONG THREE TIMES: missing column
 * defaults (CG-VEL-01 reported a PASS for a transaction that should have been
 * blocked), a missing `.lt()` on the sweep, and missing `.select()` chaining on
 * upsert. Each gap cost debugging time and the third briefly pushed production
 * code toward contorting around the harness. A double that answers "undefined"
 * to an unsupported call is worse than one that refuses: the first produces a
 * plausible wrong result, the second produces a stack trace naming the gap.
 *
 * The failure mode this closes is specifically SILENT drift — the fake falling
 * behind the real client without the drill's numbers changing.
 */
function strict<T extends object>(builder: T, what: string): T {
  const proxy: T = new Proxy(builder, {
    get(target, prop, recv) {
      if (typeof prop === "symbol" || prop in target) {
        const v = Reflect.get(target, prop, recv);
        // Builder methods return the builder itself for chaining. Re-wrap that
        // return value, otherwise the guard only covers the FIRST call and
        // everything downstream of `.select()` escapes it — which is exactly
        // how the first version of this guard managed to be dead code.
        if (typeof v === "function") {
          return (...args: Any[]) => {
            const out = (v as (...a: Any[]) => Any).apply(target, args);
            return out === target ? proxy : out;
          };
        }
        return v;
      }
      throw new Error(
        `fake_db: ${what}.${String(prop)}() is not implemented. The real PostgREST ` +
          `client supports it, so this double is behind. Implement it in fake_db.ts ` +
          `rather than changing production code to avoid it.`,
      );
    },
  });
  return proxy;
}

function matches(row: Any, preds: { op: string; col: string; val: Any }[]): boolean {
  return preds.every((p) => {
    const v = row[p.col];
    switch (p.op) {
      case "eq":
        return v === p.val;
      case "neq":
        return v !== p.val;
      case "is":
        return p.val === null ? v == null : v === p.val;
      case "in":
        return (p.val as Any[]).includes(v);
      case "lt":
        return v != null && String(v) < String(p.val);
      case "lte":
        return v != null && String(v) <= String(p.val);
      case "gte":
        return v != null && String(v) >= String(p.val);
      case "contains": {
        // jsonb containment, one level — enough for originator/beneficiary
        if (v == null || typeof v !== "object") return false;
        return Object.entries(p.val as Record<string, Any>).every(([k, want]) => v[k] === want);
      }
      default:
        return true;
    }
  });
}

/** Build the fake. `schemaOf` keys rows by "<schema>.<table>". */
export function makeDrillDb(): DrillDb {
  const rows: Record<string, Record<string, Any>[]> = {};
  const violations: ConstraintViolation[] = [];

  function check(schema: string, table: string, row: Any): ConstraintViolation | null {
    for (const [name, fn] of Object.entries(CHECKS)) {
      if (name === "provenance_core" && schema !== "core") continue;
      if (name === "provenance_sim" && schema !== "sim") continue;
      const v = fn(row, table);
      if (v) return v;
    }
    return null;
  }

  const client = {
    schema(schema: string) {
      return {
        from(table: string) {
          const key = `${schema}.${table}`;
          rows[key] ??= [];
          const preds: { op: string; col: string; val: Any }[] = [];
          let orderCol: string | null = null;
          let orderAsc = true;
          let orderNullsFirst = false;
          let lim = Infinity;
          let offset = 0;

          const chain: Any = {
            select: () => chain,
            eq: (c: string, v: Any) => (preds.push({ op: "eq", col: c, val: v }), chain),
            neq: (c: string, v: Any) => (preds.push({ op: "neq", col: c, val: v }), chain),
            is: (c: string, v: Any) => (preds.push({ op: "is", col: c, val: v }), chain),
            in: (c: string, v: Any) => (preds.push({ op: "in", col: c, val: v }), chain),
            lt: (c: string, v: Any) => (preds.push({ op: "lt", col: c, val: v }), chain),
            lte: (c: string, v: Any) => (preds.push({ op: "lte", col: c, val: v }), chain),
            gte: (c: string, v: Any) => (preds.push({ op: "gte", col: c, val: v }), chain),
            contains: (c: string, v: Any) => (preds.push({ op: "contains", col: c, val: v }), chain),
            order: (c: string, o?: { ascending?: boolean; nullsFirst?: boolean }) => {
              orderCol = c;
              orderAsc = o?.ascending !== false;
              // Postgres' DEFAULT, not a convenience: NULLS LAST for ASC,
              // NULLS FIRST for DESC. See the sort in `then` for why this
              // matters enough to model.
              orderNullsFirst = o?.nullsFirst ?? !orderAsc;
              return chain;
            },
            limit: (n: number) => (lim = n, chain),
            // PostgREST's inclusive row range — what paged reads (lib.ts
            // selectAll) walk the register with.
            range: (from: number, to: number) => (offset = from, lim = to - from + 1, chain),
            // NOTE: `chain` is returned via strict() below; add new methods HERE.

            insert(rawRow: Any) {
              const row = applyDefaults(rawRow, table, new Date().toISOString());
              const v = check(schema, table, row);
              if (v) {
                violations.push(v);
                return Promise.resolve({ data: null, error: { message: `${v.constraint}: ${v.detail}` } });
              }
              rows[key].push({ ...row });
              return Promise.resolve({ data: null, error: null });
            },

            upsert(rawRow: Any, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
              // Returns a THENABLE that also carries .select()/.maybeSingle(),
              // because the real PostgREST client supports upsert().select()
              // and a fake that does not forces production code to contort
              // around the test harness rather than the other way round.
              const run = (): Any => {
                const row = applyDefaults(rawRow, table, new Date().toISOString());
                const idx = rows[key].findIndex((r) => r.id === row.id);
                if (idx >= 0) {
                  if (opts?.ignoreDuplicates) return { data: rows[key][idx], error: null };
                  const merged = { ...rows[key][idx], ...row };
                  const v = check(schema, table, merged);
                  if (v) {
                    violations.push(v);
                    return { data: null, error: { message: `${v.constraint}: ${v.detail}` } };
                  }
                  rows[key][idx] = merged;
                  return { data: merged, error: null };
                }
                const v = check(schema, table, row);
                if (v) {
                  violations.push(v);
                  return { data: null, error: { message: `${v.constraint}: ${v.detail}` } };
                }
                rows[key].push({ ...row });
                return { data: row, error: null };
              };
              const res: Any = {
                then: (f: (v: Any) => Any) => Promise.resolve(run()).then(f),
                select: () => res,
                maybeSingle: () => Promise.resolve(run()),
                single: () => Promise.resolve(run()),
              };
              return strict(res, "upsert");
            },

            update(patch: Any) {
              const applied: Any = {
                then(res: (v: Any) => Any) {
                  const targets = rows[key].filter((r) => matches(r, preds));
                  for (const t of targets) {
                    const merged = { ...t, ...patch };
                    const v = check(schema, table, merged);
                    if (v) {
                      violations.push(v);
                      return res({ data: null, error: { message: `${v.constraint}: ${v.detail}` } });
                    }
                    Object.assign(t, patch);
                  }
                  return res({ data: null, error: null });
                },
                eq: (c: string, v: Any) => (preds.push({ op: "eq", col: c, val: v }), applied),
                is: (c: string, v: Any) => (preds.push({ op: "is", col: c, val: v }), applied),
                in: (c: string, v: Any) => (preds.push({ op: "in", col: c, val: v }), applied),
                select: () => applied,
                single: () => {
                  const targets = rows[key].filter((r) => matches(r, preds));
                  for (const t of targets) {
                    const merged = { ...t, ...patch };
                    const v = check(schema, table, merged);
                    if (v) {
                      violations.push(v);
                      return Promise.resolve({ data: null, error: { message: `${v.constraint}: ${v.detail}` } });
                    }
                    Object.assign(t, patch);
                  }
                  return Promise.resolve({ data: targets[0] ?? null, error: null });
                },
                maybeSingle: () => applied.single(),
              };
              return applied;
            },

            maybeSingle: () => {
              const found = rows[key].find((r) => matches(r, preds));
              return Promise.resolve({ data: found ? { ...found } : null, error: null });
            },
            single: () => {
              const found = rows[key].find((r) => matches(r, preds));
              return Promise.resolve({ data: found ? { ...found } : null, error: null });
            },
            then: (res: (v: Any) => Any) => {
              let out = rows[key].filter((r) => matches(r, preds)).map((r) => ({ ...r }));
              if (orderCol) {
                // NULLs are sorted, not coerced. This used to read
                // `String(a[orderCol] ?? "")`, which turns NULL into the empty
                // string — and "" sorts LAST under DESC, whereas Postgres sorts
                // NULLS FIRST. The fake's null ordering was the exact INVERSE
                // of the database's, so the null-cursor bug on GET /accounts
                // could not be reproduced by any hermetic test. Same shape as
                // the undefined-vs-NULL correction that broke 17 tests: the
                // double was being asserted against instead of the schema.
                out.sort((a, b) =>
                  pgCompare(a, b, orderCol!, { ascending: orderAsc, nullsFirst: orderNullsFirst })
                );
              }
              if (offset || lim !== Infinity) out = out.slice(offset, offset + lim);
              return res({ data: out, error: null });
            },
          };
          return strict(chain, "query");
        },
        rpc: () => Promise.resolve({ data: null, error: null }),
      };
    },
  };

  return {
    client,
    rows,
    violations,
    reset() {
      for (const k of Object.keys(rows)) delete rows[k];
      violations.length = 0;
    },
  };
}
