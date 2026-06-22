'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Role } from '@/lib/auth';
import type { TemplateSummary, TemplateDetail } from './types';
import { TemplateList } from './TemplateList';
import { TemplateDetailPanel } from './TemplateDetailPanel';

export function TemplatesClient({ currentUserId, role }: { currentUserId: string; role: Role }) {
  const [items, setItems] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string>('');
  const [ownerFilter, setOwnerFilter] = useState<'all' | 'me'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const sp = new URLSearchParams();
      if (q.trim()) sp.set('q', q.trim());
      if (category) sp.set('category', category);
      if (ownerFilter === 'me') sp.set('owner', 'me');
      const r = await fetch(`/api/reports/templates?${sp.toString()}`);
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? 'failed_to_load'); return; }
      setItems(j.templates as TemplateSummary[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed_to_load');
    } finally { setLoading(false); }
  }, [q, category, ownerFilter]);

  useEffect(() => { void loadList(); }, [loadList]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const r = await fetch(`/api/reports/templates/${id}`);
      const j = await r.json();
      if (r.ok) setDetail({ template: j.template, drift: j.drift });
      else setDetail(null);
    } finally { setDetailLoading(false); }
  }, []);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const categories = useMemo(() => {
    const s = new Set<string>();
    for (const t of items) if (t.category) s.add(t.category);
    return [...s].sort();
  }, [items]);

  async function onAction(action: 'duplicate' | 'delete', id: string) {
    if (action === 'delete') {
      if (!confirm('Delete this template? This also removes its version history.')) return;
      const r = await fetch(`/api/reports/templates/${id}`, { method: 'DELETE' });
      if (r.ok) { if (selectedId === id) setSelectedId(null); void loadList(); }
      return;
    }
    if (action === 'duplicate') {
      const r = await fetch(`/api/reports/templates/${id}/duplicate`, { method: 'POST' });
      const j = await r.json();
      if (r.ok) { setSelectedId(j.id); void loadList(); }
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tightish">Saved Reports</h1>
          <div className="text-sm text-muted mt-0.5">
            Reusable report templates produced by the agentic console. Parameterised, versioned, and drift-aware.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="pill num">{items.length} template{items.length === 1 ? '' : 's'}</span>
        </div>
      </div>

      <div className="card card-pad">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_220px_220px] gap-2">
          <input
            className="input" placeholder="Search title, description, tag…"
            value={q} onChange={e => setQ(e.target.value)}
          />
          <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">All categories</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="input" value={ownerFilter} onChange={e => setOwnerFilter(e.target.value as 'all' | 'me')}>
            <option value="all">Everyone&apos;s</option>
            <option value="me">Mine only</option>
          </select>
        </div>
      </div>

      {err && <div className="card card-pad text-err text-sm">{err}</div>}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4 items-start">
        <TemplateList
          items={items} loading={loading}
          selectedId={selectedId} onSelect={setSelectedId}
          currentUserId={currentUserId}
        />
        <TemplateDetailPanel
          detail={detail} loading={detailLoading}
          currentUserId={currentUserId} role={role}
          onAction={onAction}
          onChanged={() => { void loadList(); if (selectedId) void loadDetail(selectedId); }}
        />
      </div>
    </div>
  );
}
