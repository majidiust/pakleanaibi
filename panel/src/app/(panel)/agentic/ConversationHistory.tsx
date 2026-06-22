'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

// Shared list cache so other components (the header button label) can read
// the count without each mounting its own fetch.
async function fetchList(): Promise<ConversationSummary[]> {
  const r = await fetch('/api/agentic/conversations');
  if (!r.ok) throw new Error('failed to load conversations');
  const j = await r.json();
  return (j.conversations ?? []) as ConversationSummary[];
}

// Compact relative-time formatter so the list shows "2h ago" / "3d ago"
// without pulling in a heavy date library.
function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

export function ConversationHistory({ currentId, refreshKey, onLoad, onDeleted }: {
  currentId: string | null;
  // Bumping refreshKey from the parent forces a re-list. Used after a new
  // conversation is created or after an autosave so the timestamps stay live.
  refreshKey: number;
  onLoad: (id: string) => void | Promise<void>;
  onDeleted: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    setLoading(true); setErr(null);
    try { setItems(await fetchList()); }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed'); }
    finally { setLoading(false); }
  }, []);

  // Initial silent load so the header can show a count without the user
  // needing to open the popover first.
  useEffect(() => { void reload(); }, [reload, refreshKey]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  async function handleDelete(id: string) {
    if (!confirm('Delete this conversation? This cannot be undone.')) return;
    const r = await fetch(`/api/agentic/conversations/${id}`, { method: 'DELETE' });
    if (!r.ok) { alert('Failed to delete'); return; }
    setItems(prev => prev?.filter(c => c.id !== id) ?? null);
    onDeleted(id);
  }

  const count = items?.length ?? 0;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        className="btn-ghost btn-sm"
        onClick={() => setOpen(o => !o)}
        title="Browse past conversations">
        ☰ History{count > 0 ? ` · ${count}` : ''}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-[380px] max-h-[70vh] overflow-hidden
          rounded-lg border border-line bg-panel shadow-xl z-30 flex flex-col">
          <div className="px-3 py-2 border-b border-line flex items-center justify-between">
            <div className="text-sm font-medium">Past conversations</div>
            <button className="text-2xs text-muted hover:text-ink" onClick={() => void reload()} disabled={loading}>
              {loading ? 'Loading…' : '↻ Refresh'}
            </button>
          </div>
          <div className="overflow-y-auto flex-1">
            {err && <div className="px-3 py-3 text-xs text-err">{err}</div>}
            {!err && items && items.length === 0 && (
              <div className="px-3 py-6 text-xs text-muted text-center">
                No saved conversations yet. Each chat you start is auto-saved here.
              </div>
            )}
            {items?.map(c => (
              <div key={c.id}
                className={[
                  'group px-3 py-2 border-b border-line/60 flex items-start gap-2 cursor-pointer hover:bg-panel2/60',
                  c.id === currentId ? 'bg-accent/10' : '',
                ].join(' ')}
                onClick={() => { void onLoad(c.id); setOpen(false); }}>
                <div className="flex-1 min-w-0">
                  <div dir="auto" className="text-sm text-ink truncate" title={c.title}>{c.title}</div>
                  <div className="text-2xs text-muted mt-0.5 flex items-center gap-2">
                    <span>{relTime(c.updatedAt)}</span>
                    <span>·</span>
                    <span>{c.messageCount} msg{c.messageCount === 1 ? '' : 's'}</span>
                    {c.id === currentId && <span className="text-accent-hi">· current</span>}
                  </div>
                </div>
                <button
                  type="button"
                  className="opacity-0 group-hover:opacity-100 text-muted hover:text-err text-xs"
                  onClick={(e) => { e.stopPropagation(); void handleDelete(c.id); }}
                  aria-label="Delete conversation">✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
