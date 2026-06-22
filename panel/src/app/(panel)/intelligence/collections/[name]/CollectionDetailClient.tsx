'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { IntelTabs, PageHeader, Confidence, StatusBadge, TypeBadge } from '../../_ui';

interface Field {
  path: string; types: string[]; arrayOf?: string[]; presence: number;
  nullRate: number; distinctCount: number; uniqueness: number;
  enumValues?: (string | number | boolean)[];
  looksLikeObjectIdString?: boolean; isTimestamp?: boolean;
  examples: unknown[];
}
interface Coll {
  id: string; name: string; label?: string; description?: string;
  descriptionLocked?: boolean; entity?: string; tags: string[]; notes?: string;
  docCount: number; fields: Field[];
  indexes: { name: string; keys: Record<string, 1 | -1 | 'text'>; unique: boolean }[];
  samples: unknown[]; sampledAt: string; version: number;
}
interface Rel {
  id: string;
  source: { collection: string; field: string };
  target: { collection: string; field: string; matchOn?: string };
  type: string; status: string; confidence: number; reason: string;
}

export function CollectionDetailClient({ name, role }: { name: string; role: string }) {
  const [data, setData] = useState<{ collection: Coll; outgoing: Rel[]; incoming: Rel[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<{ description: string; entity: string; tags: string; notes: string; descriptionLocked: boolean }>(
    { description: '', entity: '', tags: '', notes: '', descriptionLocked: false }
  );

  async function load() {
    const r = await fetch('/api/intel/collections/' + encodeURIComponent(name));
    if (!r.ok) { setErr('Not found. Run an analysis first.'); return; }
    const j = await r.json();
    setData(j);
    setForm({
      description: j.collection.description ?? '',
      entity: j.collection.entity ?? '',
      tags: (j.collection.tags ?? []).join(', '),
      notes: j.collection.notes ?? '',
      descriptionLocked: !!j.collection.descriptionLocked,
    });
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [name]);

  async function save() {
    const body = {
      description: form.description,
      entity: form.entity,
      tags: form.tags.split(',').map(s => s.trim()).filter(Boolean),
      notes: form.notes,
      descriptionLocked: form.descriptionLocked,
    };
    const r = await fetch('/api/intel/collections/' + encodeURIComponent(name), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) { setErr((await r.json()).error ?? 'failed'); return; }
    setEditing(false); void load();
  }

  if (err) return <div><IntelTabs /><div className="card card-pad text-err">{err}</div></div>;
  if (!data) return <div><IntelTabs /><div className="card card-pad text-muted">Loading…</div></div>;
  const { collection: c, outgoing, incoming } = data;

  return (
    <div>
      <PageHeader title={c.label ?? c.name} subtitle={c.description || 'No description yet.'}
        actions={role === 'admin' && (editing
          ? (<>
              <button className="btn-ghost text-sm" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn-primary text-sm" onClick={save}>Save</button>
            </>)
          : <button className="btn-ghost text-sm" onClick={() => setEditing(true)}>Edit</button>)} />
      <IntelTabs />
      <div className="text-xs text-muted mb-3">
        <Link className="link" href="/intelligence/collections">Collections</Link> · {c.name}
        <span className="mx-2">·</span> v{c.version} · sampled {new Date(c.sampledAt).toLocaleString()}
      </div>

      {editing && (
        <div className="card card-pad mb-4 space-y-3">
          <div><div className="label mb-1">Entity</div>
            <input className="input" value={form.entity} onChange={e => setForm({ ...form, entity: e.target.value })} /></div>
          <div><div className="label mb-1">Description</div>
            <textarea className="input min-h-[80px]" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
          <div><div className="label mb-1">Tags (comma-separated)</div>
            <input className="input" value={form.tags} onChange={e => setForm({ ...form, tags: e.target.value })} /></div>
          <div><div className="label mb-1">Notes</div>
            <textarea className="input min-h-[60px]" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></div>
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={form.descriptionLocked} onChange={e => setForm({ ...form, descriptionLocked: e.target.checked })} />
            Lock description (don't overwrite on rescans)
          </label>
        </div>
      )}

      <div className="grid sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
        <Stat label="Documents" value={c.docCount.toLocaleString()} />
        <Stat label="Fields" value={String(c.fields.length)} />
        <Stat label="Indexes" value={String(c.indexes.length)} />
        <Stat label="Outgoing" value={String(outgoing.length)} />
        <Stat label="Incoming" value={String(incoming.length)} />
      </div>

      <Section title="Fields">
        <div className="table-wrap"><table className="bi">
          <thead><tr>
            <th>Path</th><th>Type</th><th className="text-right">Presence</th>
            <th className="text-right">Uniqueness</th><th>Hints</th><th>Examples</th>
          </tr></thead>
          <tbody>
            {c.fields.map(f => (
              <tr key={f.path}>
                <td className="font-mono">{f.path}</td>
                <td className="text-xs">
                  {f.types.join(' | ')}
                  {f.arrayOf && <span className="text-muted"> &lt;{f.arrayOf.join('|')}&gt;</span>}
                </td>
                <td className="text-right tabular-nums">{(f.presence * 100).toFixed(0)}%</td>
                <td className="text-right tabular-nums">{(f.uniqueness * 100).toFixed(0)}%</td>
                <td className="text-xs space-x-1">
                  {f.path === '_id' && <span className="pill">primary</span>}
                  {f.isTimestamp && <span className="pill">timestamp</span>}
                  {f.looksLikeObjectIdString && <span className="pill">oid-string</span>}
                  {f.uniqueness > 0.95 && f.presence > 0.9 && <span className="pill">unique?</span>}
                  {f.presence < 0.5 && <span className="pill">sparse</span>}
                  {f.enumValues && <span className="pill">enum({f.enumValues.length})</span>}
                </td>
                <td className="text-xs font-mono text-muted truncate max-w-xs">
                  {f.examples.slice(0, 3).map(e => JSON.stringify(e)).join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Section>

      <Section title="Indexes">
        <div className="table-wrap"><table className="bi">
          <thead><tr><th>Name</th><th>Keys</th><th>Unique</th></tr></thead>
          <tbody>
            {c.indexes.map(i => (
              <tr key={i.name}>
                <td className="font-mono">{i.name}</td>
                <td className="font-mono text-xs">{JSON.stringify(i.keys)}</td>
                <td>{i.unique ? <span className="pill">unique</span> : <span className="text-muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </Section>

      <Section title="Outgoing relationships">
        <RelList rels={outgoing} side="target" />
      </Section>
      <Section title="Incoming relationships">
        <RelList rels={incoming} side="source" />
      </Section>

      <Section title="Sample documents">
        <pre className="card card-pad text-xs overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(c.samples, null, 2)}
        </pre>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <div className="font-medium mb-2">{title}</div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card card-pad">
      <div className="label">{label}</div>
      <div className="text-xl font-semibold mt-1 tabular-nums">{value}</div>
    </div>
  );
}

function RelList({ rels, side }: { rels: Rel[]; side: 'source' | 'target' }) {
  if (rels.length === 0) return <div className="text-muted text-sm">None.</div>;
  return (
    <div className="table-wrap"><table className="bi">
      <thead><tr>
        <th>{side === 'target' ? 'Target' : 'Source'}</th><th>Field</th>
        <th>Type</th><th>Status</th><th>Confidence</th><th>Reason</th>
      </tr></thead>
      <tbody>
        {rels.map(r => {
          const other = side === 'target' ? r.target : r.source;
          const ownField = side === 'target' ? r.source.field : r.target.field;
          return (
            <tr key={r.id}>
              <td><Link className="link font-mono" href={`/intelligence/collections/${encodeURIComponent(other.collection)}`}>{other.collection}</Link></td>
              <td className="font-mono text-xs">{ownField} → {other.field}{('matchOn' in other && other.matchOn) ? ` (on ${other.matchOn})` : ''}</td>
              <td><TypeBadge type={r.type} /></td>
              <td><StatusBadge status={r.status} /></td>
              <td><Confidence value={r.confidence} /></td>
              <td className="text-xs text-muted max-w-md">{r.reason}</td>
            </tr>
          );
        })}
      </tbody>
    </table></div>
  );
}
