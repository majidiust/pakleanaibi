'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IntelTabs, PageHeader, Confidence, StatusBadge, TypeBadge } from '../_ui';

// Tracks any value through a short window so high-frequency inputs
// (text search, range slider) don't refetch on every keystroke.
function useDebounced<T>(value: T, delayMs = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return v;
}

interface Rel {
  id: string;
  source: { collection: string; field: string; matchOn?: string };
  target: { collection: string; field: string; matchOn?: string };
  type: string;
  status: 'suggested' | 'approved' | 'rejected' | 'manual' | 'archived';
  confidence: number;
  detection: string;
  reason: string;
  signals: { label: string; weight: number; note?: string }[];
  tags: string[];
  notes?: string;
  cardinality?: string;
  createdAt: string;
  updatedAt: string;
}

const REL_TYPES = ['one-to-one','one-to-many','many-to-one','many-to-many','embedded','soft','derived','chain'];

export function RelationshipsClient({ role }: { role: string }) {
  const [list, setList] = useState<Rel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<string>('suggested');
  const [type, setType] = useState<string>('');
  const [collection, setCollection] = useState<string>('');
  const [q, setQ] = useState('');
  const [minC, setMinC] = useState(0);
  const [creating, setCreating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const firstLoadRef = useRef(true);

  // Debounce only the high-frequency inputs; selects/buttons stay instant.
  const qDeb = useDebounced(q, 300);
  const collectionDeb = useDebounced(collection, 300);
  const minCDeb = useDebounced(minC, 200);

  const load = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    if (firstLoadRef.current) setLoading(true); else setRefreshing(true);
    const p = new URLSearchParams();
    if (status) p.set('status', status);
    if (type) p.set('type', type);
    if (collectionDeb) p.set('collection', collectionDeb);
    if (qDeb) p.set('q', qDeb);
    p.set('minConfidence', String(minCDeb));
    p.set('maxConfidence', '100');
    try {
      const r = await fetch('/api/intel/relationships?' + p.toString(), { signal: ac.signal });
      if (r.ok) setList((await r.json()).relationships);
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return;
    } finally {
      if (!ac.signal.aborted) {
        firstLoadRef.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [status, type, collectionDeb, qDeb, minCDeb]);

  useEffect(() => { void load(); }, [load]);

  async function patch(id: string, body: Record<string, unknown>) {
    const r = await fetch('/api/intel/relationships/' + id, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.ok) void load();
  }

  async function remove(id: string) {
    if (!confirm('Delete this relationship?')) return;
    const r = await fetch('/api/intel/relationships/' + id, { method: 'DELETE' });
    if (r.ok) void load();
  }

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: list.length, suggested: 0, approved: 0, rejected: 0, manual: 0, archived: 0 };
    for (const r of list) m[r.status] = (m[r.status] ?? 0) + 1;
    return m;
  }, [list]);

  return (
    <div>
      <PageHeader
        title="Relationships"
        subtitle="Review auto-discovered relationships, approve / reject, or create manual ones."
        actions={role === 'admin' && (
          <button className="btn-primary text-sm" onClick={() => setCreating(true)}>+ New manual</button>
        )}
      />
      <IntelTabs />

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <select className="input w-auto" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="suggested">Suggested ({counts.suggested ?? 0})</option>
          <option value="approved">Approved ({counts.approved ?? 0})</option>
          <option value="rejected">Rejected ({counts.rejected ?? 0})</option>
          <option value="manual">Manual ({counts.manual ?? 0})</option>
          <option value="archived">Archived</option>
        </select>
        <select className="input w-auto" value={type} onChange={e => setType(e.target.value)}>
          <option value="">All types</option>
          {REL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input className="input w-40" placeholder="Collection" value={collection} onChange={e => setCollection(e.target.value)} />
        <input className="input flex-1 min-w-[200px]" placeholder="Search field / reason / tag…" value={q}
               onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void load(); }} />
        <label className="text-xs text-muted flex items-center gap-1">
          Min conf
          <input type="range" min={0} max={100} value={minC} onChange={e => setMinC(Number(e.target.value))} />
          <span className="tabular-nums w-6">{minC}</span>
        </label>
        <span className={`text-2xs text-muted transition-opacity duration-150 ${refreshing ? 'opacity-100' : 'opacity-0'}`}>Refreshing…</span>
      </div>

      {creating && <NewRelationshipForm onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void load(); }} />}

      <div className="card">
        <div className="table-wrap rounded-b-none">
          <table className="bi">
            <thead><tr>
              <th>Source</th><th></th><th>Target</th>
              <th>Type</th><th>Status</th><th>Confidence</th>
              <th>Reason</th><th></th>
            </tr></thead>
            {/* Dim only the tbody during refresh; transitioning opacity on the
                wrap puts the sticky thead on its own compositing layer and
                causes paint tearing during scroll. */}
            <tbody className={refreshing ? 'opacity-70' : ''}>
              {loading && <tr><td colSpan={8} className="text-muted text-center py-6">Loading…</td></tr>}
              {!loading && list.length === 0 && (
                <tr><td colSpan={8} className="text-muted text-center py-6">No relationships match the current filters.</td></tr>
              )}
              {list.map(r => (
                <tr key={r.id}>
                  <td className="font-mono text-xs">
                    <Link className="link" href={`/intelligence/collections/${encodeURIComponent(r.source.collection)}`}>{r.source.collection}</Link>
                    <div className="text-muted">.{r.source.field}</div>
                  </td>
                  <td className="text-muted">→</td>
                  <td className="font-mono text-xs">
                    <Link className="link" href={`/intelligence/collections/${encodeURIComponent(r.target.collection)}`}>{r.target.collection}</Link>
                    <div className="text-muted">.{r.target.field}{r.target.matchOn ? ` (${r.target.matchOn})` : ''}</div>
                  </td>
                  <td><TypeBadge type={r.type} /></td>
                  <td><StatusBadge status={r.status} /></td>
                  <td><Confidence value={r.confidence} /></td>
                  <td className="text-xs text-muted max-w-md">
                    {r.reason}
                    {r.signals?.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {r.signals.slice(0, 6).map((s, i) => (
                          <span key={i} className="pill text-[10px]" title={s.note}>{s.label} {s.weight > 0 ? '+' : ''}{s.weight}</span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="text-xs whitespace-nowrap">
                    {role === 'admin' && (<>
                      {r.status !== 'approved' && r.status !== 'manual' && (
                        <button className="btn-ghost text-xs" onClick={() => patch(r.id, { status: 'approved' })}>Approve</button>
                      )}
                      {r.status !== 'rejected' && (
                        <button className="btn-ghost text-xs ml-1" onClick={() => patch(r.id, { status: 'rejected' })}>Reject</button>
                      )}
                      <button className="btn-ghost text-xs ml-1 text-err" onClick={() => remove(r.id)}>Delete</button>
                    </>)}
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

// Minimal shape of an intel collection used by the manual-create form: the
// name and the field paths (dot notation) so we can power per-collection
// field combo boxes.
interface CollMeta { name: string; fields: { path: string }[] }

function NewRelationshipForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    sourceCollection: '', sourceField: '',
    targetCollection: '', targetField: '_id', targetMatchOn: '',
    type: 'many-to-one', notes: '', tags: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [colls, setColls] = useState<CollMeta[]>([]);
  const [tagOptions, setTagOptions] = useState<string[]>([]);

  // Fetch real collection/field metadata once when the form is mounted so
  // every selector is a true combo: typeable, with the discovered options
  // as drop-down suggestions. Also pull existing tags so users can re-use
  // their vocabulary instead of typing free-form.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cr, rr] = await Promise.all([
          fetch('/api/intel/collections'),
          fetch('/api/intel/relationships?status=&minConfidence=0&maxConfidence=100'),
        ]);
        if (cancelled) return;
        if (cr.ok) {
          const j = await cr.json();
          setColls((j.collections ?? []).map((c: { name: string; fields?: { path: string }[] }) => ({
            name: c.name, fields: c.fields ?? [],
          })));
        }
        if (rr.ok) {
          const j = await rr.json();
          const set = new Set<string>();
          for (const r of (j.relationships ?? []) as { tags?: string[] }[]) {
            for (const t of (r.tags ?? [])) set.add(t);
          }
          setTagOptions([...set].sort());
        }
      } catch { /* combo boxes degrade to plain text inputs */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const collNames = useMemo(() => colls.map(c => c.name).sort(), [colls]);
  const sourceFields = useMemo(
    () => (colls.find(c => c.name === form.sourceCollection)?.fields ?? []).map(f => f.path),
    [colls, form.sourceCollection],
  );
  const targetFields = useMemo(
    () => (colls.find(c => c.name === form.targetCollection)?.fields ?? []).map(f => f.path),
    [colls, form.targetCollection],
  );

  // For the tags input we let the user pick from existing tags one at a time
  // via a combo, but the underlying form value is still comma-separated to
  // match the existing API contract. The "current" tag being edited is the
  // text after the last comma.
  const tagPrefix = form.tags.includes(',')
    ? form.tags.slice(0, form.tags.lastIndexOf(',') + 1)
    : '';

  async function submit() {
    setErr(null); setBusy(true);
    const body = {
      source: { collection: form.sourceCollection, field: form.sourceField },
      target: { collection: form.targetCollection, field: form.targetField, matchOn: form.targetMatchOn || undefined },
      type: form.type, notes: form.notes || undefined,
      tags: form.tags.split(',').map(s => s.trim()).filter(Boolean),
    };
    const r = await fetch('/api/intel/relationships', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    setBusy(false);
    if (!r.ok) { setErr((await r.json()).error ?? 'failed'); return; }
    onCreated();
  }

  return (
    <div className="card card-pad mb-3 space-y-2">
      <div className="font-medium">New manual relationship</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <input className="input" list="rel-coll-names" placeholder="Source collection"
               value={form.sourceCollection}
               onChange={e => setForm({ ...form, sourceCollection: e.target.value, sourceField: '' })} />
        <input className="input" list="rel-source-fields" placeholder="Source field"
               value={form.sourceField}
               onChange={e => setForm({ ...form, sourceField: e.target.value })} />
        <input className="input" list="rel-coll-names" placeholder="Target collection"
               value={form.targetCollection}
               onChange={e => setForm({ ...form, targetCollection: e.target.value, targetField: '_id', targetMatchOn: '' })} />
        <input className="input" list="rel-target-fields" placeholder="Target field"
               value={form.targetField}
               onChange={e => setForm({ ...form, targetField: e.target.value })} />
        <select className="input" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
          {REL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <input className="input" list="rel-target-fields" placeholder="Match on (optional)"
               value={form.targetMatchOn}
               onChange={e => setForm({ ...form, targetMatchOn: e.target.value })} />
        <input className="input" list="rel-tag-options" placeholder="Tags (comma-separated)"
               value={form.tags}
               onChange={e => {
                 const v = e.target.value;
                 // When the user picks a suggestion via datalist, append a
                 // trailing comma so the next pick adds to the list rather
                 // than overwriting it.
                 const picked = !v.endsWith(',') && tagOptions.includes(v.slice(tagPrefix.length).trim());
                 setForm({ ...form, tags: picked ? v + ', ' : v });
               }} />
        <input className="input" placeholder="Notes" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
      </div>
      <datalist id="rel-coll-names">{collNames.map(n => <option key={n} value={n} />)}</datalist>
      <datalist id="rel-source-fields">{sourceFields.map(f => <option key={f} value={f} />)}</datalist>
      <datalist id="rel-target-fields">{targetFields.map(f => <option key={f} value={f} />)}</datalist>
      <datalist id="rel-tag-options">{tagOptions.map(t => <option key={t} value={tagPrefix + t} />)}</datalist>
      {err && <div className="text-err text-xs">{err}</div>}
      <div className="flex justify-end gap-2">
        <button className="btn-ghost text-sm" onClick={onClose} disabled={busy}>Cancel</button>
        <button className="btn-primary text-sm" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Create'}</button>
      </div>
    </div>
  );
}
