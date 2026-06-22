'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import clsx from 'clsx';
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

// Minimal, tasteful line icons — Linear/Stripe sensibility.
const Icon = {
  Dashboard: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <rect x="2.5" y="2.5" width="6.5" height="8" rx="1.5" />
      <rect x="11" y="2.5" width="6.5" height="4.5" rx="1.5" />
      <rect x="11" y="9.5" width="6.5" height="8" rx="1.5" />
      <rect x="2.5" y="13" width="6.5" height="4.5" rx="1.5" />
    </svg>
  ),
  Reports: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" {...p}>
      <path d="M3 16V8M7.5 16V4M12 16v-6M16.5 16v-9" />
    </svg>
  ),
  Agentic: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M3.5 5.5h9a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H7l-3 2.5v-2.5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z" />
      <circle cx="6" cy="9" r="0.6" fill="currentColor" />
      <circle cx="9" cy="9" r="0.6" fill="currentColor" />
      <path d="M15.5 4.5l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" />
    </svg>
  ),
  Intelligence: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <circle cx="5" cy="5" r="2.2" /><circle cx="15" cy="5" r="2.2" />
      <circle cx="10" cy="15" r="2.2" /><path d="M6.5 6.5l7 7M13.5 6.5l-7 7M10 5h0" strokeLinecap="round" />
    </svg>
  ),
  Users: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <circle cx="10" cy="7" r="3" /><path d="M3.5 17c1-3.5 3.5-5 6.5-5s5.5 1.5 6.5 5" strokeLinecap="round" />
    </svg>
  ),
  Account: (p: IconProps) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" {...p}>
      <circle cx="10" cy="10" r="7.5" /><circle cx="10" cy="8.5" r="2.5" />
      <path d="M4.5 16.5c1.2-2 3.1-3 5.5-3s4.3 1 5.5 3" strokeLinecap="round" />
    </svg>
  ),
};

const ITEMS = [
  { href: '/dashboard',    label: 'Dashboard',    Icon: Icon.Dashboard },
  { href: '/reports',      label: 'Reports',      Icon: Icon.Reports },
  { href: '/agentic',      label: 'Agentic Report', Icon: Icon.Agentic },
  { href: '/intelligence', label: 'Intelligence', Icon: Icon.Intelligence },
  { href: '/users',        label: 'Users',        Icon: Icon.Users },
  { href: '/account',      label: 'Account',      Icon: Icon.Account },
];

function Avatar({ name }: { name: string }) {
  const initials = name.split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '·';
  return (
    <div className="size-8 shrink-0 rounded-full grid place-items-center text-2xs font-semibold text-ink
                    bg-gradient-to-b from-accent to-accent-lo border border-accent-lo/60 shadow-elev-1">
      {initials}
    </div>
  );
}

export function Sidebar({ user }: { user: { name: string; email: string; role: string } }) {
  const path = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <aside className="w-60 shrink-0 border-r border-line bg-panel/70 backdrop-blur-sm min-h-screen flex flex-col sticky top-0">
      {/* Brand lockup */}
      <div className="px-4 h-14 flex items-center gap-3 border-b border-line">
        <div className="size-8 rounded-lg grid place-items-center bg-gradient-to-br from-accent to-accent2 shadow-elev-2">
          <svg viewBox="0 0 20 20" className="size-4 text-white" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 14V6l4 5 4-7 4 10" />
          </svg>
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tightish text-ink">Paklean BI</div>
          <div className="text-2xs text-muted">Operational reporting</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        <div className="label px-3 pb-1 pt-1">Workspace</div>
        {ITEMS.map(({ href, label, Icon: I }) => {
          const active = path === href || path.startsWith(href + '/');
          return (
            <Link key={href} href={href}
              className={clsx(
                'relative flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors duration-150 ease-snappy',
                active
                  ? 'text-ink bg-panel2/70'
                  : 'text-muted hover:text-ink hover:bg-panel2/50',
              )}>
              {active && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-accent" aria-hidden />
              )}
              <I className={clsx('size-4 shrink-0', active ? 'text-accent-hi' : 'text-muted')} />
              <span className="tracking-tightish">{label}</span>
            </Link>
          );
        })}
      </nav>

      {/* User footer */}
      <div className="border-t border-line p-3">
        <div className="flex items-center gap-3 px-1 py-1.5">
          <Avatar name={user.name} />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-ink truncate tracking-tightish">{user.name}</div>
            <div className="text-2xs text-muted truncate">{user.email}</div>
          </div>
          <span className="pill-accent">{user.role}</span>
        </div>
        <button onClick={logout} className="btn-subtle btn-sm w-full mt-2 justify-start">
          <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M8 4H4v12h4M12 7l3 3-3 3M15 10H7" />
          </svg>
          Sign out
        </button>
      </div>
    </aside>
  );
}
