'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import type { ReactNode } from 'react';

export const TABS = [
  { href: '/intelligence', label: 'Overview' },
  { href: '/intelligence/collections', label: 'Collections' },
  { href: '/intelligence/relationships', label: 'Relationships' },
  { href: '/intelligence/graph', label: 'Graph' },
  { href: '/intelligence/versions', label: 'Versions' },
];

export function IntelTabs() {
  const path = usePathname();
  return (
    <div className="flex flex-wrap gap-1 border-b border-line mb-4">
      {TABS.map(t => {
        const active = path === t.href ||
          (t.href !== '/intelligence' && path.startsWith(t.href));
        return (
          <Link key={t.href} href={t.href}
            className={clsx(
              'relative px-3 py-2 text-sm border-b-2 -mb-px transition-colors duration-150 ease-snappy tracking-tightish',
              active
                ? 'border-accent text-ink'
                : 'border-transparent text-muted hover:text-ink-2',
            )}>
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

export function Confidence({ value }: { value: number }) {
  if (value < 0) return <span className="pill" style={{ background: '#5b8def33', color: '#9bb8ff' }}>manual</span>;
  const color = value >= 90 ? '#22c55e' : value >= 70 ? '#5b8def' : value >= 50 ? '#f59e0b' : '#ef4444';
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-1.5 rounded bg-panel2 overflow-hidden">
        <div style={{ width: `${value}%`, background: color }} className="h-full" />
      </div>
      <span className="text-xs tabular-nums" style={{ color }}>{value}</span>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    suggested: 'bg-warn/15 text-warn border-warn/40',
    approved: 'bg-ok/15 text-ok border-ok/40',
    rejected: 'bg-err/15 text-err border-err/40',
    manual: 'bg-accent/15 text-accent border-accent/40',
    archived: 'bg-panel2 text-muted border-line',
  };
  return (
    <span className={clsx('inline-flex items-center px-2 py-0.5 text-xs rounded-full border', map[status] ?? 'pill')}>
      {status}
    </span>
  );
}

export function TypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    'one-to-one': '#7c5cff',
    'one-to-many': '#5b8def',
    'many-to-one': '#22c55e',
    'many-to-many': '#f59e0b',
    'embedded': '#a78bfa',
    'soft': '#94a3b8',
    'derived': '#06b6d4',
    'chain': '#f472b6',
  };
  const c = colors[type] ?? '#94a3b8';
  return (
    <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-full border"
      style={{ background: c + '20', color: c, borderColor: c + '60' }}>
      {type}
    </span>
  );
}

export function PageHeader({ title, subtitle, actions }: {
  title: string; subtitle?: string; actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 mb-3">
      <div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
