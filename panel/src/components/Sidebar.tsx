'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import clsx from 'clsx';

const ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: '◧' },
  { href: '/reports', label: 'Reports', icon: '✦' },
  { href: '/intelligence', label: 'Intelligence', icon: '◆' },
  { href: '/users', label: 'Users', icon: '◉' },
  { href: '/account', label: 'Account', icon: '◐' },
];

export function Sidebar({ user }: { user: { name: string; email: string; role: string } }) {
  const path = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  return (
    <aside className="w-60 shrink-0 border-r border-line bg-panel/60 min-h-screen flex flex-col">
      <div className="px-5 py-5 border-b border-line">
        <div className="text-lg font-semibold tracking-tight">Paklean BI</div>
        <div className="text-xs text-muted">Operational reporting</div>
      </div>
      <nav className="flex-1 py-3">
        {ITEMS.map(item => {
          const active = path === item.href || path.startsWith(item.href + '/');
          return (
            <Link key={item.href} href={item.href}
              className={clsx(
                'flex items-center gap-3 px-5 py-2 text-sm border-l-2',
                active
                  ? 'border-accent bg-panel2 text-ink'
                  : 'border-transparent text-muted hover:bg-panel2/60 hover:text-ink',
              )}>
              <span className="text-accent w-4 text-center">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-line p-4 text-sm">
        <div className="text-ink truncate">{user.name}</div>
        <div className="text-xs text-muted truncate">{user.email}</div>
        <div className="mt-1"><span className="pill">{user.role}</span></div>
        <button onClick={logout} className="btn-ghost w-full mt-3 text-xs">Sign out</button>
      </div>
    </aside>
  );
}
