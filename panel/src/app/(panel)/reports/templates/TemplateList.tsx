'use client';
import type { TemplateSummary } from './types';

function relTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '—';
  const s = Math.max(1, Math.floor((Date.now() - d) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24); if (days < 14) return `${days}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

function VisibilityPill({ v }: { v: TemplateSummary['visibility'] }) {
  if (v === 'shared') return <span className="pill-accent">shared</span>;
  if (v === 'public') return <span className="pill-accent">public</span>;
  return <span className="pill">private</span>;
}

function LastRunPill({ t }: { t: TemplateSummary }) {
  if (!t.lastRunAt) return <span className="pill text-muted-2">never run</span>;
  if (t.lastRunStatus === 'failed') return <span className="pill-err">last run failed</span>;
  return <span className="pill-ok">ok · {relTime(t.lastRunAt)}</span>;
}

export function TemplateList({
  items, loading, selectedId, onSelect, currentUserId,
}: {
  items: TemplateSummary[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  currentUserId: string;
}) {
  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-line flex items-center justify-between">
        <div className="h-sect">Templates</div>
        <span className="text-2xs text-muted">{loading ? 'Loading…' : `${items.length} item${items.length === 1 ? '' : 's'}`}</span>
      </div>
      {items.length === 0 && !loading && (
        <div className="p-6 text-sm text-muted">
          No saved reports yet. Use the agentic console to build a query, then click
          <span className="kbd mx-1">Save as template</span> to add it here.
        </div>
      )}
      <div className="divide-y divide-line max-h-[calc(100vh-260px)] overflow-y-auto">
        {items.map(t => {
          const active = t.id === selectedId;
          const mine = t.createdBy === currentUserId;
          return (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              className={[
                'w-full text-left px-4 py-3 block transition-colors duration-150',
                active ? 'bg-panel2/80' : 'hover:bg-panel2/40',
              ].join(' ')}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-ink truncate">{t.title}</span>
                    {mine && <span className="text-2xs text-muted-2">· yours</span>}
                  </div>
                  {t.description && (
                    <div className="text-xs text-muted mt-0.5 line-clamp-2">{t.description}</div>
                  )}
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    <span className="pill"><span className="text-muted mr-1">on</span>
                      <span className="font-mono text-ink-2">{t.collection}</span></span>
                    <VisibilityPill v={t.visibility} />
                    <LastRunPill t={t} />
                    {t.category && <span className="pill">{t.category}</span>}
                    {(t.tags ?? []).slice(0, 3).map(tag => (
                      <span key={tag} className="pill text-muted-2">#{tag}</span>
                    ))}
                  </div>
                </div>
                <div className="text-right text-2xs text-muted-2 whitespace-nowrap pt-0.5">
                  <div>v{t.version}</div>
                  <div className="mt-1">{relTime(t.updatedAt)}</div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
