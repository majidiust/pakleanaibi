'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { IntelTabs, PageHeader } from '../_ui';

interface Coll {
  id: string; name: string; description?: string; entity?: string;
  tags: string[]; docCount: number; fields: { path: string }[];
  incoming: number; outgoing: number;
}

export function CollectionsClient({ role: _role }: { role: string }) {
  const [list, setList] = useState<Coll[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tag) params.set('tag', tag);
    const r = await fetch('/api/intel/collections?' + params.toString());
    if (r.ok) setList((await r.json()).collections);
    setLoading(false);
  }
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const allTags = useMemo(() => {
    const s = new Set<string>();
    for (const c of list) for (const t of c.tags) s.add(t);
    return [...s].sort();
  }, [list]);

  return (
    <div>
      <PageHeader title="Collections" subtitle="Auto-discovered schema. Click a collection to see its fields, samples and relationships." />
      <IntelTabs />
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input className="input max-w-xs" placeholder="Search name, description, entity, tag…" value={q}
               onChange={e => setQ(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter') void load(); }} />
        <button className="btn-ghost text-sm" onClick={() => void load()}>Search</button>
        <div className="flex flex-wrap gap-1 ml-2">
          {allTags.map(t => (
            <button key={t}
              className={`pill text-xs ${tag === t ? '!bg-accent !text-white !border-accent' : ''}`}
              onClick={() => { setTag(tag === t ? null : t); setTimeout(load, 0); }}>{t}</button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="table-wrap rounded-b-none">
          <table className="bi">
            <thead><tr>
              <th>Collection</th><th>Entity</th><th>Description</th>
              <th className="text-right">Docs</th>
              <th className="text-right">Fields</th>
              <th className="text-right">In · Out</th>
              <th>Tags</th>
            </tr></thead>
            <tbody>
              {loading && <tr><td colSpan={7} className="text-muted text-center py-6">Loading…</td></tr>}
              {!loading && list.length === 0 && (
                <tr><td colSpan={7} className="text-muted text-center py-6">
                  No collections yet. Run an analysis from the Overview tab.
                </td></tr>
              )}
              {list.map(c => (
                <tr key={c.id}>
                  <td className="font-mono">
                    <Link className="link" href={`/intelligence/collections/${encodeURIComponent(c.name)}`}>{c.name}</Link>
                  </td>
                  <td>{c.entity ? <span className="pill">{c.entity}</span> : <span className="text-muted">—</span>}</td>
                  <td className="max-w-md">
                    <div className="text-sm line-clamp-2">{c.description ?? <span className="text-muted">—</span>}</div>
                  </td>
                  <td className="text-right tabular-nums">{c.docCount.toLocaleString()}</td>
                  <td className="text-right tabular-nums">{c.fields.length}</td>
                  <td className="text-right tabular-nums text-xs text-muted">{c.incoming} · {c.outgoing}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {c.tags.slice(0, 4).map(t => <span key={t} className="pill text-xs">{t}</span>)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
