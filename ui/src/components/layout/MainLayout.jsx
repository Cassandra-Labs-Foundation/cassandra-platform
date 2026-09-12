// src/components/layout/MainLayout.jsx
import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import {
  Search,
  Bell,
  Settings,
  User,
  DollarSign,
  BarChart2,
  Users,
  Shield,
  Grid,
  Book,
  CheckSquare,
  CalendarClock,
  BarChart3,
  Activity,
  Link as LinkIcon
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
      <Search size={18} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400" />
      <input
        type="text"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') runSearch();
          if (e.key === 'Escape') close();
        }}
        placeholder="Find a member: name, email, member / account / transfer ID…"
        className="pl-10 pr-4 py-2 bg-slate-100 rounded-md w-full max-w-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
      />
      {searching && (
        <div className="absolute z-40 mt-1 w-full max-w-md bg-white border border-slate-200 rounded-md shadow-lg p-3 text-sm text-slate-500">
          Searching…
        </div>
      )}
      {!searching && results !== null && (
        <div className="absolute z-40 mt-1 w-full max-w-md bg-white border border-slate-200 rounded-md shadow-lg overflow-hidden">
          {results.length === 0 ? (
            <div className="p-3 text-sm text-slate-500">
              No member found. Names, emails and ent_ / acct_ / tr_ ids are searchable.
            </div>
          ) : (
            results.map((m) => (
              <button
                key={m.id}
                onClick={() => open(m.id)}
                className="w-full text-left px-3 py-2 hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
              >
                <div className="text-sm font-medium text-slate-800">{m.name}</div>
                <div className="text-xs text-slate-500 font-mono">{m.id}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default function MainLayout({ children, title, subtitle, actions }) {
  const { user } = useSession();
  const router = useRouter();

  // Determine active route from current path
  const currentPath = router.pathname;

  return (
    <div className="flex h-screen bg-slate-50 text-slate-800 overflow-hidden">
      {/* Left Sidebar */}
      <div className="w-16 md:w-64 bg-white border-r border-slate-200 flex flex-col">
        <div className="p-4 border-b border-slate-200">
          <div className="font-bold text-xl hidden md:block">Pynthia Banking</div>
          <div className="md:hidden flex justify-center">
            <Shield size={24} className="text-blue-600" />
          </div>
        </div>
        
        <nav className="flex-1 py-6">
          <ul>
            <NavItem 
              href="/"
              icon={<Grid size={20} />} 
              label="Home" 
              active={currentPath === '/'} 
            />
            <NavItem 
              href="/teller"
              icon={<DollarSign size={20} />} 
              label="Teller" 
              active={currentPath === '/teller'} 
            />
            <NavItem 
              href="/member-services"
              icon={<Users size={20} />} 
              label="Member Services" 
              active={currentPath === '/member-services'} 
            />
            <NavItem
              href="/accounting"
              icon={<BarChart2 size={20} />} 
              label="Accounting" 
              active={currentPath === '/accounting'} 
            />
            <NavItem
              href="/approvals"
              icon={<CheckSquare size={20} />}
              label="Approvals"
              active={currentPath === '/approvals'}
            />
            <NavItem
              href="/compliance"
              icon={<CalendarClock size={20} />}
              label="Compliance"
              active={currentPath === '/compliance'}
            />
            <NavItem
              href="/compliance/dashboard"
              icon={<Activity size={20} />}
              label="Monitoring"
              active={currentPath.startsWith('/compliance/dashboard')}
            />
            <NavItem
              href="/call-report"
              icon={<BarChart3 size={20} />}
              label="Call Report"
              active={currentPath === '/call-report'}
            />
            <NavItem
              href="/reports"
              icon={<Book size={20} />}
              label="Reports"
              active={currentPath === '/reports'}
            />
            <NavItem 
              href="/administrator"
              icon={<Shield size={20} />} 
              label="Admin" 
              active={currentPath === '/administrator'} 
            />
          </ul>
        </nav>
        
        <div className="p-4 border-t border-slate-200">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white">
              <User size={16} />
            </div>
            <div className="hidden md:block">
              <div className="font-semibold text-sm">{user.name}</div>
              <div className="text-xs text-slate-500">{user.role}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-6">
          <div className="flex items-center space-x-3 w-1/3">
            <GlobalSearch />
          </div>
          
          {/* "Accounting · Treasury · Cards · API" used to sit here, styled as
              primary navigation and wired to nothing. Two of the four named
              sections that do not exist at all, and the other two duplicated
              the sidebar. Removed rather than re-pointed: a nav bar whose job
              is already done by the rail beside it is clutter even when it
              works. */}

          <div className="flex items-center space-x-4">
            <NotificationBell />
            {/* Was a dead gear. There is no settings page, but Admin is where
                system configuration actually lives, so it goes there. */}
            <Link
              href="/administrator"
              className="text-slate-600 hover:text-slate-900"
              title="Admin"
            >
              <Settings size={20} />
            </Link>
          </div>
        </header>
        
        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto p-6">
          {/* Header Section */}
          <div className="mb-6 flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-semibold mb-2">{title}</h1>
              <p className="text-slate-500">{subtitle}</p>
            </div>
            <div className="flex items-center space-x-3">
              {actions}
            </div>
          </div>
          
          {/* Main Content */}
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
        className="text-slate-600 hover:text-slate-900 relative"
        title={unread ? `${unread} unread` : 'Notifications'}
      >
        <Bell size={20} />
        {unread > 0 && (
          <span className="absolute top-0 right-0 w-2 h-2 bg-red-500 rounded-full"></span>
        )}
      </button>

      {open && (
        <>
          {/* Click-away, behind the panel. */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 bg-white border border-slate-200 rounded-lg shadow-lg z-20 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50 flex justify-between items-center">
              <span className="text-sm font-medium text-slate-700">Notifications</span>
              {notifications.length > 0 && (
                <button
                  onClick={clearNotifications}
                  className="text-xs text-blue-600 hover:underline"
                >
                  Clear all
                </button>
              )}
            </div>
            {notifications.length === 0 ? (
              <div className="p-4 text-sm text-slate-500 text-center">
                Nothing to report.
              </div>
            ) : (
              <div className="max-h-80 overflow-y-auto">
                {notifications.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => markNotificationRead(n.id)}
                    className={`w-full text-left px-4 py-2.5 border-b border-slate-100 last:border-b-0 hover:bg-slate-50 ${
                      n.read ? 'opacity-60' : ''
                    }`}
                  >
                    <div className="text-sm">{n.message}</div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {n.type}
                      {!n.read && <span className="ml-2 text-blue-600">unread</span>}
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

// Navigation Item Component
function NavItem({ href, icon, label, active }) {
  return (
    <li className="mb-1">
      <Link href={href} passHref>
        <div
          className={`flex items-center w-full py-2.5 px-4 rounded-md cursor-pointer ${
            active 
              ? 'bg-blue-50 text-blue-600' 
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <span className="mr-3">{icon}</span>
          <span className="hidden md:block font-medium text-sm">{label}</span>
        </div>
      </Link>
    </li>
  );
}