// src/components/layout/MainLayout.jsx
import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  Search,
  Bell,
  Settings,
  Users,
  Shield,
  Home,
  Banknote,
  BarChart2,
  Activity,
  CheckSquare,
  CalendarClock,
  FileText,
  Table2,
} from 'lucide-react';
import { useSession } from '../../lib/context/SessionContext';
import { searchMembers } from '../../lib/api';

/**
 * The header search, wired to the same finder as the teller's lookup.
 *
 * This input shipped as bare chrome — no handler, while its placeholder
 * promised member search and a command palette. The palette never existed
 * anywhere, so the placeholder now promises exactly what pressing Enter does:
 * find a member by name, email, member id, account id or transfer id, and
 * jump to their profile.
 *
 * Search fires on Enter, not per keystroke: behind it is a paged walk of the
 * whole entity table, not an index lookup.
 */
function GlobalSearch() {
  const router = useRouter();
  const [term, setTerm] = useState('');
  const [results, setResults] = useState(null); // null = no search yet
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);

  const runSearch = async () => {
    const query = term.trim();
    if (!query) return;
    const mySeq = ++seq.current;
    setSearching(true);
    try {
      const found = await searchMembers(query);
      // A slow earlier search must not land on top of a newer one.
      if (seq.current === mySeq) setResults(found.slice(0, 8));
    } catch (err) {
      console.error('Global search failed:', err);
      if (seq.current === mySeq) setResults([]);
    } finally {
      if (seq.current === mySeq) setSearching(false);
    }
  };

  const close = () => {
    setResults(null);
    setTerm('');
  };

  const open = (memberId) => {
    close();
    router.push(`/members/${memberId}`);
  };

  return (
    <div className="relative flex-grow">
      <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft" />
      <input
        type="text"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') runSearch();
          if (e.key === 'Escape') close();
        }}
        placeholder="Find a member"
        title="Find a member by name, email, member ID, account ID or transfer ID"
        aria-label="Find a member"
        className="pl-10 pr-4 py-2 bg-[#f1f4f8] rounded-lg w-full max-w-md shadow-[inset_0_1px_2px_rgb(11_31_58/0.08)] placeholder:text-ink-soft focus:outline-none focus:ring-2 focus:ring-accent text-sm"
      />
      {searching && (
        <div className="absolute z-40 mt-1 w-full max-w-md bg-white rounded-lg shadow-e2 p-3 text-sm text-ink-muted">
          Searching…
        </div>
      )}
      {!searching && results !== null && (
        <div className="absolute z-40 mt-1 w-full max-w-md bg-white rounded-lg shadow-e2 overflow-hidden">
          {results.length === 0 ? (
            <div className="p-3 text-sm text-ink-muted">
              No member found. Names, emails and ent_ / acct_ / tr_ ids are searchable.
            </div>
          ) : (
            results.map((m) => (
              <button
                key={m.id}
                onClick={() => open(m.id)}
                className="w-full text-left px-3 py-2 hover:bg-canvas border-b border-line last:border-b-0"
              >
                <div className="text-sm font-semibold text-ink">{m.name}</div>
                <div className="text-xs text-ink-muted font-mono">{m.id}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// Navigation, grouped by job. Labels are what the pages are; "Obligations" is
// the governance calendar at /compliance.
const NAV = [
  { items: [{ href: '/', label: 'Home', Icon: Home, match: (p) => p === '/' }] },
  {
    group: 'Operations',
    items: [
      { href: '/teller', label: 'Teller', Icon: Banknote },
      { href: '/member-services', label: 'Member Services', Icon: Users, match: (p) => p === '/member-services' || p.startsWith('/members') || p.startsWith('/accounts') },
      { href: '/accounting', label: 'Accounting', Icon: BarChart2 },
    ],
  },
  {
    group: 'Compliance',
    items: [
      { href: '/compliance/dashboard', label: 'Monitoring', Icon: Activity, match: (p) => p.startsWith('/compliance/dashboard') },
      { href: '/approvals', label: 'Approvals', Icon: CheckSquare },
      { href: '/compliance', label: 'Obligations', Icon: CalendarClock, match: (p) => p === '/compliance' },
    ],
  },
  {
    group: 'Reporting',
    items: [
      { href: '/call-report', label: 'Call Report', Icon: FileText },
      { href: '/reports', label: 'Reports', Icon: Table2 },
    ],
  },
];

const initials = (name = '') =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

/**
 * The application shell.
 *
 * `status` is an optional node shown at the right of the header (Monitoring
 * passes the core's live heartbeat); `statusCompact` replaces it below 1024px. It is per-page on purpose: the heartbeat
 * polls the core, and pages that do not show live figures should not pay for it.
 */
export default function MainLayout({ children, title, subtitle, actions, status, statusCompact }) {
  const { user } = useSession();
  const router = useRouter();
  const currentPath = router.pathname;
  const isActive = (it) => (it.match ? it.match(currentPath) : currentPath === it.href);

  return (
    <div className="flex h-screen bg-canvas text-ink overflow-hidden">
      <aside
        aria-label="Main"
        className="relative z-10 w-16 md:w-62 shrink-0 bg-gradient-to-b from-rail to-[#0a1c36] flex flex-col px-2 md:px-3 pt-4 pb-3 shadow-[inset_-1px_0_0_rgb(255_255_255/0.04),6px_0_18px_-10px_rgb(11_31_58/0.5)]"
      >
        <Link href="/" className="flex items-center justify-center md:justify-start gap-2.5 px-2 pb-3.5 text-white" aria-label="Cassandra home">
          <span className="grid place-items-center w-7 h-7 rounded-lg bg-white shadow-[0_2px_6px_rgb(0_0_0/0.35)]" aria-hidden="true">
            <span className="block w-3.5 h-3.5 rounded-full border-[3px] border-ink border-r-accent" />
          </span>
          <span className="hidden md:block text-[17px] font-bold tracking-tight">Cassandra</span>
        </Link>

        <div className="hidden md:flex items-center gap-2.5 mx-0.5 mb-2 px-2.5 py-2 rounded-xl bg-white/[0.06] shadow-[inset_0_0_0_1px_rgb(255_255_255/0.07)]">
          <span className="grid place-items-center w-6.5 h-6.5 rounded-md bg-[#1f7a5c] text-white text-[13px] font-bold" aria-hidden="true">P</span>
          <span className="leading-tight">
            <span className="block text-[13px] font-semibold text-white">Pynthia Credit Union</span>
            <span className="block text-xs text-[#a9b8cf]">Narrow bank · NCUA</span>
          </span>
        </div>

        <nav className="flex-1 overflow-y-auto">
          {NAV.map((sec, i) => (
            <div key={sec.group ?? i}>
              {sec.group && (
                <div className="hidden md:block px-2.5 pt-3 pb-1.5 text-xs font-semibold text-rail-muted">{sec.group}</div>
              )}
              {sec.group && <div className="md:hidden my-2 mx-3 h-px bg-white/10" aria-hidden="true" />}
              <ul>
                {sec.items.map((it) => (
                  <NavItem key={it.href} {...it} active={isActive(it)} />
                ))}
              </ul>
            </div>
          ))}
        </nav>

        <div
          className="hidden md:flex items-center gap-2 mx-0.5 mb-2 px-2.5 py-2 rounded-lg bg-silent/[0.12] shadow-[inset_0_0_0_1px_rgb(247_144_9/0.28)] text-xs text-[#fcd9a6]"
          title="The core behind this console holds synthetic demo data, not real member records."
        >
          <span className="w-1.5 h-1.5 rounded-full bg-silent" aria-hidden="true" />
          Demo core · synthetic data
        </div>
        <div
          className="md:hidden mx-auto mb-2 flex flex-col items-center gap-1 px-1.5 py-1.5 rounded-lg bg-silent/[0.14] shadow-[inset_0_0_0_1px_rgb(247_144_9/0.35)] text-xs font-semibold text-[#fcd9a6]"
          title="Demo core · synthetic data"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-silent" aria-hidden="true" />
          Demo
          <span className="sr-only">core, synthetic data</span>
        </div>
        <ul>
          <NavItem href="/administrator" label="Admin" Icon={Shield} active={currentPath === '/administrator'} />
        </ul>

        <div className="flex items-center justify-center md:justify-start gap-2.5 px-1.5 pt-2.5 mt-1 shadow-[0_-1px_0_rgb(255_255_255/0.07)]">
          <span
            className="grid place-items-center shrink-0 w-7.5 h-7.5 rounded-full bg-[#dbe6ff] text-ink text-xs font-bold ring-2 ring-white/10"
            title={`${user.name} · ${user.role}`}
          >
            {initials(user.name)}
          </span>
          <span className="hidden md:block flex-1 min-w-0 leading-tight">
            <span className="block text-[13px] font-semibold text-white truncate">{user.name}</span>
            <span className="block text-xs text-[#a9b8cf] truncate">{user.role}{user.branch ? ` · ${user.branch}` : ''}</span>
          </span>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <header className="h-14 shrink-0 bg-white/85 shadow-[0_1px_0_var(--color-line)] flex items-center gap-4 px-4 md:px-7">
          <div className="flex-1 min-w-0 max-w-md">
            <GlobalSearch />
          </div>
          <div className="ml-auto flex items-center gap-4">
            {status && <div className="hidden lg:block">{status}</div>}
            {statusCompact && <div className="lg:hidden">{statusCompact}</div>}
            <NotificationBell />
            {/* No settings page exists; Admin is where configuration lives. */}
            <Link href="/administrator" className="text-ink-muted hover:text-ink" title="Admin" aria-label="Admin">
              <Settings size={20} />
            </Link>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-5 md:px-7 md:py-6">
          <div className="mb-5 flex flex-wrap gap-3 justify-between items-end">
            <div className="min-w-0">
              <h1 className="text-[26px] leading-tight font-bold tracking-tight">{title}</h1>
              {subtitle && <p className="text-sm text-ink-muted mt-0.5">{subtitle}</p>}
            </div>
            {actions && <div className="flex items-center gap-2">{actions}</div>}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * The bell, wired to the session's real notification list.
 *
 * The red dot is now conditional on there actually being something unread.
 * Before, it was painted on unconditionally beside a seeded fake notice, so
 * it signalled nothing — a permanent alert is the same as no alert.
 */
function NotificationBell() {
  const { notifications, markNotificationRead, clearNotifications } = useSession();
  const [open, setOpen] = useState(false);
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="text-ink-muted hover:text-ink relative"
        title={unread ? `${unread} unread` : 'Notifications'}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
      >
        <Bell size={20} />
        {unread > 0 && (
          <span className="absolute top-0 right-0 w-2 h-2 bg-[#d92d20] rounded-full" aria-hidden="true"></span>
        )}
      </button>

      {open && (
        <>
          {/* Click-away, behind the panel. */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 bg-white rounded-xl shadow-e2 z-20 overflow-hidden">
            <div className="px-4 py-2.5 bg-canvas shadow-[0_1px_0_var(--color-line)] flex justify-between items-center">
              <span className="text-sm font-semibold text-ink">Notifications</span>
              {notifications.length > 0 && (
                <button
                  onClick={clearNotifications}
                  className="text-xs font-semibold text-accent hover:underline"
                >
                  Clear all
                </button>
              )}
            </div>
            {notifications.length === 0 ? (
              <div className="p-4 text-sm text-ink-muted text-center">
                Nothing to report.
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {notifications.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => markNotificationRead(n.id)}
                    className={`w-full text-left px-4 py-2.5 border-b border-line last:border-b-0 hover:bg-canvas ${
                      n.read ? 'opacity-60' : ''
                    }`}
                  >
                    <div className="text-sm">{n.message}</div>
                    <div className="text-xs text-ink-soft mt-0.5">
                      {n.type}
                      {!n.read && <span className="ml-2 text-accent">unread</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function NavItem({ href, label, Icon, active }) {
  return (
    <li className="mb-px">
      <Link
        href={href}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        title={label}
        className={`flex items-center justify-center md:justify-start gap-2.5 px-2.5 py-[7px] rounded-lg text-sm font-medium transition-colors duration-150 ${
          active
            ? 'bg-white text-ink font-semibold shadow-chip'
            : 'text-rail-text hover:bg-white/[0.06] hover:text-white'
        }`}
      >
        <Icon size={18} strokeWidth={1.8} className={active ? 'text-accent' : 'text-rail-muted'} aria-hidden="true" />
        <span className="hidden md:block">{label}</span>
      </Link>
    </li>
  );
}
