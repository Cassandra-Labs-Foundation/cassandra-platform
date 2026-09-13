// src/pages/accounting.jsx
//
// The credit union's financial statements — the pro-forma's four blocks, LIVE:
// Statement of Financial Condition, Income Statement, Key Ratios, and Growth &
// Productivity. Every cell the live core can source is a real number that moves
// as transactions settle; every cell it cannot is shown as its regulatory
// TARGET or a plain "—", never faked and never dropped. Pure actuals — no
// projection overlay, no bounce to the Call Report.
//
// What the deposit ledger actually sources (and therefore what is live):
//   - the whole liability/deposit side: member shares by product, totals;
//   - the position (FBO) and its tie-out to member shares;
//   - membership: headcount, the growth curve (from entity created_at), and
//     average shares per member;
//   - transfer activity over time, and the live tape.
// What it cannot source (targets or "—"): loans, the investment portfolio,
// fixed assets, equity/reserves, and the entire income statement — so net
// worth, ROA, cost of funds, yield and loans-to-assets carry their targets.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Activity, RefreshCw, Users, PiggyBank, Scale, TrendingUp, Target, ChevronRight, X, ArrowUpRight, CheckCircle2, Circle } from 'lucide-react';
import MainLayout from '../components/layout/MainLayout';
import { DeltaChip, LiveBadge, LiveValue } from '../components/live/Live';
import { AreaTrend, BarSeries } from '../components/accounting/charts';
import { useLiveCore } from '../lib/useLiveCore';
import {
  fetchRawAccounts,
  fetchReport5300,
  fetchMembershipSummary,
  fetchTransferFlow,
  formatCents,
  formatWhen,
  summarizeAccounts,
} from '../lib/api';

const PRODUCT = {
  checking: 'Share drafts (checking)',
  savings: 'Regular shares (savings)',
  money_market: 'Money market shares',
  certificate: 'Share certificates',
  ira: 'IRA / KEOGH',
  keogh: 'IRA / KEOGH',
};
const productLabel = (t) => PRODUCT[t] ?? (t ? t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Other shares');
const PRODUCT_COLOR = ['#2563eb', '#0891b2', '#7c3aed', '#0d9488', '#d97706', '#64748b'];
const POSITION_HUE = '#2563eb';
const FLOW_HUE = '#0891b2';
const GROWTH_HUE = '#059669';

const STATUS_STYLE = {
  settled: 'bg-emerald-50 text-emerald-700',
  completed: 'bg-emerald-50 text-emerald-700',
  pending: 'bg-amber-50 text-amber-700',
  returned: 'bg-rose-50 text-rose-700',
  rejected: 'bg-rose-50 text-rose-700',
  canceled: 'bg-slate-100 text-slate-600',
};

function fmtCompact(cents) {
  const d = (cents ?? 0) / 100;
  const a = Math.abs(d);
  if (a >= 1e9) return `$${(d / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(d / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(d / 1e3).toFixed(1)}K`;
  return `$${d.toFixed(0)}`;
}

// A line on a financial statement: a label, and either a sourced value or a "—"
// with the reason it isn't sourced. `total` styles the rollup rows; `onClick`
// makes it drill.
function Line({ label, value, note, sub, total, indent, onClick }) {
  const clickable = !!onClick;
  return (
    <div
      onClick={onClick}
      className={`flex items-baseline justify-between gap-3 py-1.5 -mx-2 px-2 rounded transition-colors ${total ? 'border-t border-slate-200 mt-1 pt-2 font-semibold' : ''} ${clickable ? 'cursor-pointer hover:bg-blue-50/60' : ''}`}
    >
      <div className={indent ? 'pl-3' : ''}>
        <span className={`text-sm ${total ? 'text-slate-800' : 'text-slate-600'}`}>{label}</span>
        {sub && <span className="text-xs text-slate-400"> · {sub}</span>}
        {note && <div className="text-[11px] text-slate-400">{note}</div>}
      </div>
      <div className="text-sm tabular-nums whitespace-nowrap flex items-center gap-1">
        {value == null ? <span className="text-slate-300">—</span> : <span className={total ? 'text-slate-900' : 'text-slate-700'}>{formatCents(value)}</span>}
        {clickable && <ChevronRight size={13} className="text-slate-300 shrink-0" />}
      </div>
    </div>
  );
}

// A ratio card: a live actual when sourced, otherwise the regulatory target and
// a "—". Clicking drills into its formula and inputs.
function Ratio({ label, actual, target, needs, good, onClick }) {
  return (
    <div onClick={onClick} className={`p-4 transition-colors ${onClick ? 'cursor-pointer hover:bg-blue-50/60' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-slate-700 flex items-center gap-1">
          {label}
          {onClick && <ChevronRight size={12} className="text-slate-300" />}
        </span>
        {actual != null ? (
          <span className={`text-lg font-semibold tabular-nums ${good ? 'text-emerald-700' : 'text-slate-900'}`}>{actual}</span>
        ) : (
          <span className="text-lg font-semibold text-slate-300">—</span>
        )}
      </div>
      {actual == null && target && (
        <div className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-slate-500">
          <Target size={11} /> target {target}
        </div>
      )}
      {needs && <div className="text-[11px] text-slate-400 mt-0.5">{actual == null ? `needs ${needs}` : needs}</div>}
    </div>
  );
}

// Ratio metadata — shared by the cards and the drill-down. `sourced` ones carry
// a live actual (computed at render); the rest carry a target and the input the
// core would need to book first.
const RATIO_DEFS = [
  { key: 'nw', label: 'Net worth ratio', target: '7%+ (well-capitalized)', needs: 'equity / reserves', formula: '(undivided earnings + reserves) ÷ total assets' },
  { key: 'roa', label: 'Return on avg. assets', target: 'positive', needs: 'net income', formula: 'net income ÷ average assets' },
  { key: 'cof', label: 'Cost of funds', target: 'managed', needs: 'dividend expense', formula: '(dividend + interest expense) ÷ average shares & borrowings' },
  { key: 'lta', label: 'Loans to assets', target: 'per ALM policy', needs: 'loan balances', formula: 'total loans ÷ total assets' },
  { key: 'cash', label: 'Cash + ST inv. to assets', sourced: true, formula: '(cash + short-term investments) ÷ total assets', needs: 'narrow bank — all assets liquid' },
  { key: 'avg', label: 'Avg. shares / member', sourced: true, formula: 'total member shares ÷ members', needs: 'deposit book ÷ members' },
  { key: 'yld', label: 'Yield on investments', target: 'per portfolio', needs: 'an investment portfolio', formula: 'investment income ÷ average investments' },
  { key: 'del', label: 'Delinquency', target: '0%', needs: 'loan performance', formula: 'delinquent loans ÷ total loans' },
];

// What each metric is made of — for the drill-down. `inputs` is a checklist:
// `have:true` is sourced from the live core; `have:false` names the missing
// input and, in `detail`, exactly what the core would have to book first. This
// is the honest version of the pro-forma: every line is present, and clicking
// one says why it is a value or a target.
const SOURCING = {
  // ── balance sheet · assets
  loans: {
    title: 'Loans & leases', formula: 'principal outstanding, net of ALLL',
    inputs: [
      { label: 'Loan balances', have: false, detail: 'core.loan exists, but no production writer ever sets a balance — a loan-origination flow must post principal and amortize it.' },
      { label: 'Allowance for loan & lease losses (ALLL)', have: false, detail: 'a contra-asset, provisioned from a loss model.' },
    ],
  },
  fixed: {
    title: 'Fixed & other assets',
    inputs: [
      { label: 'Fixed-asset register', have: false, detail: 'GL asset accounts + accumulated depreciation; none are modelled.' },
      { label: 'Accrued interest receivable & intangibles', have: false, detail: 'accrual runs posting to a receivable account.' },
    ],
  },
  // ── balance sheet · liabilities & equity
  nonmember: {
    title: 'Non-member deposits', sourced: true, formula: 'deposits held for non-members',
    inputs: [{ label: 'Non-member deposit accounts', have: true, detail: 'none — every deposit here is a member share (fintech end-users are members via CIF), so this line is $0.' }],
  },
  equity: {
    title: 'Reserves & undivided earnings',
    inputs: [
      { label: 'Equity / reserve GL accounts', have: false, detail: 'the core has no equity accounts at all.' },
      { label: 'Undivided-earnings roll', have: false, detail: 'net income closed to retained earnings each period — needs an income statement first.' },
    ],
  },
  // ── income statement
  intinc: {
    title: 'Interest & investment income', formula: 'loan interest + investment income',
    inputs: [
      { label: 'A double-entry general ledger', have: false, detail: 'core.bookkeeping_entry is single-sided (one amount, no debit/credit pair, no account_id) — nothing can post to an income line.' },
      { label: 'Interest accrual runs', have: false, detail: 'accruals posting to interest income; core.interest_accrual_run does not feed a GL.' },
      { label: 'An investment portfolio with a yield', have: false, detail: 'treasuries / CDs booked with a rate — the core holds the cash but records no instrument.' },
    ],
  },
  feeinc: {
    title: 'Fee & BaaS program income', formula: 'member fees + BaaS program fees',
    inputs: [
      { label: 'Fee events booked to income', have: false, detail: 'NSF / wire / money-order fees posted to a fee-income account.' },
      { label: 'A BaaS program fee schedule', have: false, detail: 'upfront / omnibus / per-ACH / per-wire fees applied per program — the pro-forma’s Assumptions tab.' },
    ],
  },
  grossinc: { title: 'Gross income', derived: true, formula: 'interest & investment income + fee & BaaS income', inputs: [{ label: 'Interest & investment income', have: false }, { label: 'Fee & BaaS income', have: false }] },
  opex: { title: 'Operating expenses', inputs: [{ label: 'An expense GL / AP feed', have: false, detail: 'salaries, occupancy, marketing and office operations posted to expense accounts.' }] },
  divexp: { title: 'Dividend expense (cost of funds)', inputs: [{ label: 'Dividend declarations', have: false, detail: 'a dividend rate per share product, declared and posted each period — the pro-forma’s Assumptions tab.' }] },
  plll: { title: 'Provision for loan losses', inputs: [{ label: 'A loan portfolio and a loss model', have: false, detail: 'needs loans first, then a provisioning rule.' }] },
  netinc: { title: 'Net income', derived: true, formula: 'gross income − expenses − dividends − PLLL', inputs: [{ label: 'Gross income', have: false }, { label: 'Operating & dividend expense, PLLL', have: false }] },
  // ── ratios (unsourced)
  nw: { title: 'Net worth ratio', target: '7%+ (well-capitalized)', formula: '(undivided earnings + reserves) ÷ total assets', inputs: [{ label: 'Equity / reserves', have: false, detail: 'no equity accounts in the core.' }, { label: 'Total assets', have: false, detail: 'loans + investments + fixed, none booked.' }] },
  roa: { title: 'Return on average assets', target: 'positive', formula: 'net income ÷ average assets', inputs: [{ label: 'Net income', have: false, detail: 'the whole income statement above.' }, { label: 'Average assets', have: false, detail: 'a period-over-period asset history.' }] },
  cof: { title: 'Cost of funds', target: 'managed', formula: '(dividend + interest expense) ÷ average funding', inputs: [{ label: 'Dividend expense', have: false }, { label: 'Interest expense on borrowings', have: false }] },
  lta: { title: 'Loans to assets', target: 'per ALM policy', formula: 'total loans ÷ total assets', inputs: [{ label: 'Loan balances', have: false, detail: 'core.loan has no writer.' }] },
  yld: { title: 'Yield on investments', target: 'per portfolio', formula: 'investment income ÷ average investments', inputs: [{ label: 'An investment portfolio and its income', have: false }] },
  del: { title: 'Delinquency', target: '0%', formula: 'delinquent loans ÷ total loans', inputs: [{ label: 'A loan portfolio with delinquency status', have: false }] },
  // ── ratios (sourced)
  cash: { title: 'Cash + ST investments to assets', sourced: true, formula: '(cash + short-term investments) ÷ total assets', inputs: [{ label: 'Cash & investments (FBO backing)', have: true }, { label: 'Total assets', have: true, detail: 'a narrow bank holds only the liquid backing, so the ratio is 100%.' }] },
  avg: { title: 'Average shares per member', sourced: true, formula: 'total member shares ÷ members', inputs: [{ label: 'Total member shares', have: true }, { label: 'Member headcount', have: true }] },
};

// The drill-down surface: a right-side drawer whose content depends on what was
// clicked — the accounts behind a balance-sheet line, the position tie-out, the
// membership growth, or a ratio's formula and inputs.
function Drawer({ drill, ctx, onClose }) {
  if (!drill) return null;
  const { rawAccounts, report, members, fbo, memberShare, fboDiff, depositBook, avgPerMember } = ctx;

  let title = '';
  let body = null;

  if (drill.kind === 'accounts') {
    const rows = (rawAccounts ?? [])
      .filter((a) => (drill.type ? a.account_type === drill.type : true))
      .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0));
    const total = rows.reduce((s, a) => s + (a.balance ?? 0), 0);
    title = drill.label ?? 'Accounts';
    body = (
      <>
        <div className="text-sm text-slate-500 mb-3">{rows.length.toLocaleString()} accounts · {formatCents(total)}</div>
        <div className="space-y-1">
          {rows.slice(0, 200).map((a) => (
            <Link key={a.id} href={`/accounts/${a.id}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-slate-50 border border-transparent hover:border-slate-200">
              <span className="font-mono text-xs text-blue-600 truncate">{a.id}</span>
              <span className="flex items-center gap-2 shrink-0">
                <span className={`text-[11px] ${a.status === 'open' ? 'text-slate-400' : 'text-amber-600'}`}>{a.status}</span>
                <span className="text-sm tabular-nums text-slate-700">{formatCents(a.balance ?? 0)}</span>
                <ArrowUpRight size={12} className="text-slate-300" />
              </span>
            </Link>
          ))}
        </div>
        {rows.length > 200 && <div className="text-xs text-slate-400 mt-2">showing the 200 largest of {rows.length.toLocaleString()}</div>}
      </>
    );
  } else if (drill.kind === 'position') {
    title = 'Position & FBO tie-out';
    body = (
      <div className="space-y-3 text-sm">
        <Row label="Deposit book (all programs)" value={depositBook} />
        <Row label="Member shares (this instance)" value={memberShare} />
        <Row label="FBO position (Payment Hub)" value={fbo} />
        <Row label="Reconciliation difference" value={fboDiff} tone={fboDiff === 0 ? 'ok' : 'warn'} />
        <p className="text-xs text-slate-500 pt-2 border-t border-slate-100">
          A program&rsquo;s FBO balance is money the credit union owes it, so it must equal that program&rsquo;s member shares — the
          core reports the difference ({fboDiff === 0 ? 'tied to the cent' : formatCents(fboDiff ?? 0, { signed: true })}).
          The deposit book is larger because this operator can list every partner program, not just this instance.
        </p>
        {report?.current?.updated_at && <div className="text-xs text-slate-400">Position as of {formatWhen(report.current.updated_at)} · seq {report.current.last_seq?.toLocaleString?.() ?? report.current.last_seq}</div>}
      </div>
    );
  } else if (drill.kind === 'members') {
    const g = members?.growth ?? [];
    title = 'Membership growth';
    body = (
      <>
        <div className="text-sm text-slate-500 mb-3">{members?.count?.toLocaleString?.() ?? '—'} members · {formatCents(Math.round(avgPerMember ?? 0))} avg shares</div>
        <table className="w-full text-sm">
          <thead><tr className="text-[11px] uppercase tracking-wide text-slate-500"><th className="text-left py-1">Month</th><th className="text-right py-1">Added</th><th className="text-right py-1">Cumulative</th></tr></thead>
          <tbody>
            {[...g].reverse().map((m) => (
              <tr key={m.month} className="border-t border-slate-100"><td className="py-1">{m.month}</td><td className="py-1 text-right tabular-nums text-emerald-600">+{m.added.toLocaleString()}</td><td className="py-1 text-right tabular-nums">{m.cumulative.toLocaleString()}</td></tr>
            ))}
          </tbody>
        </table>
        <Link href="/member-services" className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline mt-3">Open Member Services <ArrowUpRight size={13} /></Link>
      </>
    );
  } else if (drill.kind === 'sourcing') {
    const s = SOURCING[drill.key];
    title = s.title;
    const haveCount = s.inputs.filter((i) => i.have).length;
    body = (
      <div className="space-y-4 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="text-slate-500">Current</span>
          {drill.actual != null
            ? <span className="text-2xl font-semibold tabular-nums text-slate-900">{drill.actual}</span>
            : s.target
              ? <span className="inline-flex items-center gap-1 text-sm text-slate-600"><Target size={14} /> target {s.target}</span>
              : <span className="text-2xl font-semibold text-slate-300">—</span>}
        </div>
        {s.formula && (
          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Formula</div>
            <div className="font-mono text-xs text-slate-700 bg-slate-50 rounded px-2 py-1.5">{s.formula}</div>
          </div>
        )}
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1.5">
            {s.sourced ? 'Inputs' : `Missing inputs · ${haveCount}/${s.inputs.length} sourced`}
          </div>
          <ul className="space-y-2.5">
            {s.inputs.map((inp, i) => (
              <li key={i} className="flex gap-2">
                {inp.have ? <CheckCircle2 size={15} className="text-emerald-600 shrink-0 mt-0.5" /> : <Circle size={15} className="text-slate-300 shrink-0 mt-0.5" />}
                <div>
                  <div className={inp.have ? 'text-slate-700' : 'text-slate-700 font-medium'}>{inp.label}</div>
                  {inp.detail && <div className="text-[11px] text-slate-400 leading-snug">{inp.detail}</div>}
                </div>
              </li>
            ))}
          </ul>
        </div>
        {!s.sourced && (
          <p className="text-xs text-slate-400 pt-2 border-t border-slate-100">
            Shown, not faked — this populates once the core books the inputs above to a double-entry general ledger.{s.derived ? ' It is a rollup, so it lands only when its parts do.' : ''}
          </p>
        )}
      </div>
    );
  } else if (drill.kind === 'transfers') {
    title = 'Recent settled transfers';
    body = (
      <>
        <div className="text-sm text-slate-500 mb-3">{ctx.flowCount != null ? `${ctx.flowCount.toLocaleString()} total` : ''}</div>
        <ul className="divide-y divide-slate-100">
          {(ctx.tape ?? []).map((t) => (
            <li key={t.id} className="py-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-medium tabular-nums text-slate-800">{formatCents(t.amountCents)}</div>
                <div className="text-[11px] text-slate-400 truncate">{t.createdAt ? formatWhen(t.createdAt) : '—'} · <span className="font-mono">{t.id}</span></div>
              </div>
              <span className="text-[11px] text-slate-500 shrink-0">{t.status}</span>
            </li>
          ))}
        </ul>
      </>
    );
  } else if (drill.kind === 'transfer') {
    const t = drill.transfer;
    title = 'Transfer';
    body = (
      <div className="space-y-3 text-sm">
        <div className="text-3xl font-semibold tabular-nums text-slate-900">{formatCents(t.amountCents)}</div>
        <div className="flex justify-between"><span className="text-slate-500">Status</span><span className="text-slate-800">{t.status}</span></div>
        <div className="flex justify-between"><span className="text-slate-500">Settled</span><span className="text-slate-800">{t.createdAt ? formatWhen(t.createdAt) : '—'}</span></div>
        <div className="flex justify-between gap-3"><span className="text-slate-500 shrink-0">Transfer id</span><span className="font-mono text-xs text-slate-800 truncate">{t.id}</span></div>
        <p className="text-xs text-slate-400 pt-2 border-t border-slate-100">The transfer&rsquo;s parties and rail live on the member and account pages — this read exposes the amount, status and time.</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-slate-900/20" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-md bg-white shadow-xl border-l border-slate-200 flex flex-col">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between shrink-0">
          <h3 className="font-semibold text-slate-800">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 rounded p-1 hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="overflow-y-auto p-4 flex-1">{body}</div>
      </div>
    </div>
  );
}

function Row({ label, value, tone }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={`tabular-nums font-medium ${tone === 'ok' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : 'text-slate-800'}`}>{value == null ? '—' : formatCents(value)}</span>
    </div>
  );
}

export default function Accounting() {
  const [ledger, setLedger] = useState(null);
  const [rawAccounts, setRawAccounts] = useState(null); // the account rows, for drill-downs
  const [report, setReport] = useState(null);
  const [members, setMembers] = useState(null);
  const [flow, setFlow] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [drill, setDrill] = useState(null); // the open drill-down, or null

  const [posSeries, setPosSeries] = useState([]); // live FBO position over the session
  const openingBook = useRef(null);

  const load = useCallback((isRefresh) => {
    if (isRefresh) setIsRefreshing(true);
    const accountsP = fetchRawAccounts()
      .then((rows) => { setRawAccounts(rows); setLedger(summarizeAccounts(rows)); setError(''); })
      .catch((e) => { console.error('accounts:', e); setError(e.message); });
    fetchReport5300().then(setReport).catch(() => {});
    fetchMembershipSummary().then(setMembers).catch(() => {});
    fetchTransferFlow().then(setFlow).catch(() => {});
    Promise.allSettled([accountsP]).then(() => setIsRefreshing(false));
  }, []);

  useEffect(() => { load(false); }, [load]);

  const { live, polledAt, lastAdvanceAt, error: liveError } = useLiveCore({ onAdvance: () => load(true) });
  const fbo = live?.fboCents ?? report?.current?.fbo_position_cents ?? null;

  const lastPoll = useRef(null);
  useEffect(() => {
    if (fbo == null) return;
    const key = polledAt ?? Date.now();
    if (lastPoll.current === key) return;
    lastPoll.current = key;
    setPosSeries((s) => { const n = [...s, { t: Date.now(), v: fbo }]; return n.length > 160 ? n.slice(n.length - 160) : n; });
  }, [fbo, polledAt]);

  const depositBook = ledger?.totalCents ?? null;
  const memberShare = report?.memberShareCents ?? null;
  const fboDiff = report?.fboDiffCents ?? null;
  const bookVsScope = depositBook != null && memberShare != null ? depositBook - memberShare : null;

  useEffect(() => {
    if (openingBook.current === null && typeof depositBook === 'number') openingBook.current = depositBook;
  }, [depositBook]);
  const bookDelta = typeof depositBook === 'number' && openingBook.current !== null ? depositBook - openingBook.current : null;

  const totalOpen = ledger ? ledger.byType.reduce((s, r) => s + r.open, 0) : null;
  const avgPerMember = typeof depositBook === 'number' && members?.count ? depositBook / members.count : null;

  const products = useMemo(() => {
    if (!ledger) return [];
    const walked = ledger.byType.reduce((s, r) => s + r.balanceCents, 0) || 1;
    return ledger.byType
      .map((r, i) => ({ ...r, label: productLabel(r.type), color: PRODUCT_COLOR[i % PRODUCT_COLOR.length], pct: (r.balanceCents / walked) * 100 }))
      .sort((a, b) => b.balanceCents - a.balanceCents);
  }, [ledger]);

  const flowBuckets = useMemo(() => {
    const byDay = new Map();
    for (const t of flow?.transfers ?? []) {
      if (!t.createdAt) continue;
      const day = t.createdAt.slice(0, 10);
      const b = byDay.get(day) ?? { volume: 0, count: 0 };
      b.volume += t.amountCents; b.count += 1;
      byDay.set(day, b);
    }
    const out = [];
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const b = byDay.get(key) ?? { volume: 0, count: 0 };
      out.push({ key, label: d.toLocaleDateString([], { month: 'short', day: 'numeric' }), volume: b.volume, count: b.count });
    }
    return out;
  }, [flow]);
  const flow30 = flowBuckets.reduce((a, b) => ({ volume: a.volume + b.volume, count: a.count + b.count }), { volume: 0, count: 0 });

  const growthSeries = useMemo(
    () => (members?.growth ?? []).map((g) => ({ t: `${g.month}-01`, v: g.cumulative })),
    [members],
  );
  const tape = (flow?.transfers ?? []).slice(0, 10);

  // Narrow bank: every asset is the cash/treasury backing the deposits, so
  // cash + short-term investments to assets is 100% — a real, computable ratio.
  const cashToAssets = fbo != null ? '100.0%' : null;

  return (
    <MainLayout
      title="Accounting"
      subtitle="The financial statements, live — the deposit ledger's actuals, with targets where the core doesn't book it yet"
      actions={
        <div className="flex items-center space-x-3">
          <LiveBadge live={live} polledAt={polledAt} lastAdvanceAt={lastAdvanceAt} error={liveError} />
          <button onClick={() => load(true)} disabled={isRefreshing} className="px-3 py-2 text-sm border border-slate-300 rounded-md hover:bg-slate-50 flex items-center disabled:opacity-50">
            <RefreshCw size={16} className={`mr-1.5 ${isRefreshing ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      }
    >
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
          <h3 className="font-medium text-red-800">Could not load the deposit book</h3>
          <p className="text-sm text-red-600 mt-0.5">{error}</p>
        </div>
      )}

      {/* ───────────────────────── hero: live position + trend */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-5 pb-2 flex items-start justify-between">
            <div onClick={() => setDrill({ kind: 'accounts', label: 'All share accounts' })} className="cursor-pointer group -m-1 p-1 rounded">
              <div className="flex items-center text-sm font-medium text-slate-500 mb-1"><PiggyBank size={15} className="mr-1.5 text-blue-600" /> Total shares &amp; deposits <ChevronRight size={14} className="text-slate-300 ml-1 group-hover:text-blue-400" /></div>
              <div className="text-4xl font-semibold tabular-nums text-slate-900">
                <LiveValue value={depositBook}>{depositBook != null ? formatCents(depositBook) : '—'}</LiveValue>
                <DeltaChip cents={bookDelta} format={formatCents} />
              </div>
              <div className="text-xs text-slate-500 mt-1">{ledger ? `${ledger.accountCount.toLocaleString()}${ledger.truncated ? '+' : ''} share accounts, all programs` : ' '}</div>
            </div>
            <div className="text-right">
              {fbo != null && memberShare != null && (
                <div className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${fboDiff === 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                  <Scale size={12} /> {fboDiff === 0 ? 'FBO tied out' : `FBO ${formatCents(fboDiff ?? 0, { signed: true })}`}
                </div>
              )}
              <div className="text-[11px] text-slate-400 mt-1">{report?.current?.updated_at ? <>Payment Hub · {formatWhen(report.current.updated_at)}</> : ' '}</div>
            </div>
          </div>
          <div className="px-2 pb-2">
            {posSeries.length >= 2 ? (
              <AreaTrend data={posSeries} height={120} color={POSITION_HUE} formatV={formatCents} formatT={(t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })} />
            ) : (
              <div className="h-[120px] flex items-center justify-center text-xs text-slate-400"><Activity size={13} className="mr-1.5" /> watching the position — the line draws as it&rsquo;s polled</div>
            )}
          </div>
        </div>
        <div className="grid grid-rows-2 gap-4">
          <div onClick={() => setDrill({ kind: 'members' })} className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm cursor-pointer hover:border-blue-300 transition-colors">
            <div className="flex items-center justify-between text-sm font-medium text-slate-500 mb-1"><span className="flex items-center"><Users size={15} className="mr-1.5 text-slate-500" /> Members</span><ChevronRight size={14} className="text-slate-300" /></div>
            <div className="text-2xl font-semibold tabular-nums">{members ? `${members.count.toLocaleString()}${members.truncated ? '+' : ''}` : '—'}</div>
            <div className="text-xs text-slate-500 mt-1">{ledger ? `${ledger.accountCount.toLocaleString()} accounts · ${(totalOpen ?? 0).toLocaleString()} open` : ' '}</div>
          </div>
          <div onClick={() => setDrill({ kind: 'sourcing', key: 'avg', actual: avgPerMember != null ? formatCents(Math.round(avgPerMember)) : null })} className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm cursor-pointer hover:border-blue-300 transition-colors">
            <div className="flex items-center justify-between text-sm font-medium text-slate-500 mb-1"><span>Avg. share balance / member</span><ChevronRight size={14} className="text-slate-300" /></div>
            <div className="text-2xl font-semibold tabular-nums">{avgPerMember != null ? formatCents(Math.round(avgPerMember)) : '—'}</div>
            <div className="text-xs text-slate-500 mt-1">deposit book ÷ members</div>
          </div>
        </div>
      </div>

      {/* ───────────────────────── statement of financial condition + income statement */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {/* balance sheet */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
            <h2 className="text-sm font-semibold text-slate-700">Statement of Financial Condition</h2>
          </div>
          <div className="px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Assets</div>
            <Line label="Cash & investments" sub="member-share backing" value={fbo} onClick={() => setDrill({ kind: 'position' })} />
            <Line label="Loans & leases" value={null} note="no loan ledger — core.loan has no writer" onClick={() => setDrill({ kind: 'sourcing', key: 'loans' })} />
            <Line label="Fixed & other assets" value={null} note="not booked" onClick={() => setDrill({ kind: 'sourcing', key: 'fixed' })} />
            <Line label="Total assets" value={fbo} total onClick={() => setDrill({ kind: 'position' })} />

            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1 mt-4">Liabilities &amp; Equity</div>
            {products.map((p) => (
              <Line key={p.type} label={p.label} sub={`${p.count.toLocaleString()} accts · ${p.pct.toFixed(1)}%`} value={p.balanceCents} indent onClick={() => setDrill({ kind: 'accounts', type: p.type, label: p.label })} />
            ))}
            {products.length === 0 && <div className="text-sm text-slate-400 py-2">walking the account book…</div>}
            <Line label="Non-member deposits" value={0} indent onClick={() => setDrill({ kind: 'sourcing', key: 'nonmember', actual: formatCents(0) })} />
            <Line label="Reserves & undivided earnings" value={null} note="no equity accounts in the core" indent onClick={() => setDrill({ kind: 'sourcing', key: 'equity' })} />
            <Line label="Total liabilities & equity" value={depositBook} total onClick={() => setDrill({ kind: 'accounts', label: 'All share accounts' })} />
          </div>
          {bookVsScope != null && Math.abs(bookVsScope) > 0 && (
            <div className="px-4 py-2.5 border-t border-slate-200 bg-slate-50 text-[11px] text-slate-500">
              Assets are the FBO backing scoped to this instance ({formatCents(fbo)}); the deposit side lists every program this
              operator sees ({formatCents(depositBook)}). The {formatCents(Math.abs(bookVsScope))} gap is accounts outside this instance, not a drift.
            </div>
          )}
        </div>

        {/* income statement */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
            <h2 className="text-sm font-semibold text-slate-700">Income Statement</h2>
          </div>
          <div className="px-4 py-3">
            <Line label="Interest & investment income" value={null} onClick={() => setDrill({ kind: 'sourcing', key: 'intinc' })} />
            <Line label="Fee & BaaS program income" value={null} onClick={() => setDrill({ kind: 'sourcing', key: 'feeinc' })} />
            <Line label="Gross income" value={null} total onClick={() => setDrill({ kind: 'sourcing', key: 'grossinc' })} />
            <Line label="Operating expenses" value={null} onClick={() => setDrill({ kind: 'sourcing', key: 'opex' })} />
            <Line label="Dividend expense (cost of funds)" value={null} onClick={() => setDrill({ kind: 'sourcing', key: 'divexp' })} />
            <Line label="Provision for loan losses" value={null} onClick={() => setDrill({ kind: 'sourcing', key: 'plll' })} />
            <Line label="Net income" value={null} total onClick={() => setDrill({ kind: 'sourcing', key: 'netinc' })} />
          </div>
          <div className="px-4 py-2.5 border-t border-slate-200 bg-slate-50 text-[11px] text-slate-500">
            The core is a deposit ledger — it books no income or expense yet (`core.bookkeeping_entry` is single-sided). These lines
            populate once interest, fees and dividends post to a GL; until then they are shown, not faked.
          </div>
        </div>
      </div>

      {/* ───────────────────────── key ratios */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden mb-4">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
          <h2 className="text-sm font-semibold text-slate-700">Key Ratios</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">Live actuals where the core sources them; the regulatory target otherwise.</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y divide-slate-100">
          {RATIO_DEFS.map((r) => {
            const actual = r.key === 'cash' ? cashToAssets : r.key === 'avg' ? (avgPerMember != null ? formatCents(Math.round(avgPerMember)) : null) : null;
            return (
              <Ratio key={r.key} label={r.label} actual={actual} target={r.target} needs={r.needs} good={r.sourced} onClick={() => setDrill({ kind: 'sourcing', key: r.key, actual })} />
            );
          })}
        </div>
      </div>

      {/* ───────────────────────── growth & productivity + tape */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3 space-y-4">
          {/* member growth */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <div className="flex items-start justify-between mb-2">
              <div>
                <button onClick={() => setDrill({ kind: 'members' })} className="flex items-center text-sm font-medium text-slate-700 hover:text-blue-700"><Users size={15} className="mr-1.5 text-emerald-600" /> Member growth <ChevronRight size={13} className="text-slate-300 ml-0.5" /></button>
                <div className="text-xs text-slate-500 mt-0.5">cumulative members over time · from account-opening dates</div>
              </div>
              <div className="text-right">
                <div className="text-xl font-semibold tabular-nums text-slate-900">{members ? members.count.toLocaleString() : '—'}</div>
                <div className="text-xs text-slate-500">members</div>
              </div>
            </div>
            {growthSeries.length >= 2 ? (
              <AreaTrend data={growthSeries} height={110} color={GROWTH_HUE} formatV={(v) => `${v.toLocaleString()} members`} formatT={(t) => new Date(t).toLocaleDateString([], { month: 'short', year: 'numeric' })} />
            ) : (
              <div className="h-[110px] flex items-center justify-center text-xs text-slate-400">{members ? 'not enough history to chart' : 'loading membership…'}</div>
            )}
          </div>
          {/* transfer activity */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <button onClick={() => setDrill({ kind: 'transfers' })} className="flex items-center text-sm font-medium text-slate-700 hover:text-blue-700"><TrendingUp size={15} className="mr-1.5 text-cyan-600" /> Transfer activity — 30 days <ChevronRight size={13} className="text-slate-300 ml-0.5" /></button>
                <div className="text-xs text-slate-500 mt-0.5">settled transfer volume per day · the flow the position rides</div>
              </div>
              <div className="text-right">
                <div className="text-xl font-semibold tabular-nums text-slate-900">{fmtCompact(flow30.volume)}</div>
                <div className="text-xs text-slate-500">{flow30.count.toLocaleString()} transfers · 30 days</div>
              </div>
            </div>
            <BarSeries data={flowBuckets.map((b) => ({ label: `${b.label} · ${b.count} transfer${b.count === 1 ? '' : 's'}`, v: b.volume }))} height={110} color={FLOW_HUE} formatV={fmtCompact} emptyNote={flow ? 'no settled transfers in the last 30 days' : 'loading activity…'} />
          </div>
        </div>

        {/* live tape */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700 flex items-center"><Activity size={14} className="mr-1.5 text-emerald-600" /> Recent settled transfers</h2>
            <span className="text-xs text-slate-500">{flow ? `${flow.transfers.length.toLocaleString()}${flow.truncated ? '+' : ''} total` : ' '}</span>
          </div>
          {!flow ? (
            <div className="p-6 text-center text-slate-500 text-sm"><div className="animate-spin inline-block w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full mb-2" />Loading the tape…</div>
          ) : tape.length === 0 ? (
            <div className="p-6 text-center text-slate-500 text-sm">No settled transfers yet.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {tape.map((t) => (
                <li key={t.id} onClick={() => setDrill({ kind: 'transfer', transfer: t })} className="px-4 py-2.5 flex items-center justify-between gap-3 cursor-pointer hover:bg-slate-50">
                  <div className="min-w-0">
                    <div className="text-sm font-medium tabular-nums text-slate-800">{formatCents(t.amountCents)}</div>
                    <div className="text-[11px] text-slate-400 truncate">{t.createdAt ? formatWhen(t.createdAt) : '—'} · <span className="font-mono">{t.id.slice(0, 12)}</span></div>
                  </div>
                  <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_STYLE[t.status] ?? 'bg-slate-100 text-slate-600'}`}>{t.status}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 text-[11px] text-slate-400">Updates when the core&rsquo;s event sequence advances — a new settlement appears at the top.</div>
        </div>
      </div>

      <Drawer drill={drill} ctx={{ rawAccounts, report, members, fbo, memberShare, fboDiff, depositBook, avgPerMember, tape, flowCount: flow?.transfers?.length }} onClose={() => setDrill(null)} />
    </MainLayout>
  );
}
