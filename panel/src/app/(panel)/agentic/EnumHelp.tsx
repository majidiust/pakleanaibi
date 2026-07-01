'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Chat-side "cheat sheet" for enum-like fields. Analysts open this popover
// while composing a message to remind themselves which values a field can
// take AND to author short definitions ("paid" = "Order fully settled")
// that then flow into the LLM prompt via getSchema()/schemaToPrompt().
//
// Data sources:
//   - GET /api/reports/schema  -> digest with enumValues (from intel scan)
//   - GET /api/intel/enum-labels -> analyst-authored per-value definitions
//
// Edits go to PATCH /api/intel/enum-labels; the server also invalidates the
// schema digest cache so the next agentic turn sees the new definitions.

interface Field { name: string; types: string[]; enumValues?: (string | number | boolean)[] }
interface Coll { name: string; count: number; fields: Field[] }
interface Digest { collections: Coll[] }
interface LabelDoc { collection: string; path: string; labels: Record<string, string> }

type LabelsByField = Map<string, Record<string, string>>;   // key: `${coll}.${path}`

export function EnumHelp({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [labels, setLabels] = useState<LabelsByField>(new Map());
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<string | null>(null);   // `${coll}.${path}`
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // key: `${coll}.${path}::${value}`
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const openPopover = useCallback(async () => {
    setOpen(true);
    if (digest && labels.size > 0) return;
    setLoading(true); setErr(null);
    try {
      const [sr, lr] = await Promise.all([
        fetch('/api/reports/schema'),
        fetch('/api/intel/enum-labels'),
      ]);
      if (!sr.ok) throw new Error('failed to load schema');
      const sj = await sr.json();
      setDigest(sj.digest as Digest);
      if (lr.ok) {
        const lj = await lr.json();
        const m: LabelsByField = new Map();
        for (const d of (lj.items ?? []) as LabelDoc[]) m.set(`${d.collection}.${d.path}`, d.labels || {});
        setLabels(m);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : 'failed to load'); }
    finally { setLoading(false); }
  }, [digest, labels]);

  // Flatten: one row per (collection, enum field). Search filters by
  // collection name, field name, or any value spelling so an analyst who
  // remembers only the value ("paid") can still find its owning field.
  const rows = useMemo(() => {
    if (!digest) return [] as { coll: string; field: Field }[];
    const needle = q.trim().toLowerCase();
    const out: { coll: string; field: Field }[] = [];
    for (const c of digest.collections) {
      for (const f of c.fields) {
        if (!f.enumValues || f.enumValues.length === 0) continue;
        if (!needle) { out.push({ coll: c.name, field: f }); continue; }
        const hit = c.name.toLowerCase().includes(needle) ||
          f.name.toLowerCase().includes(needle) ||
          f.enumValues.some(v => String(v).toLowerCase().includes(needle));
        if (hit) out.push({ coll: c.name, field: f });
      }
    }
    return out;
  }, [digest, q]);

  async function saveField(coll: string, path: string) {
    const key = `${coll}.${path}`;
    const cur = labels.get(key) ?? {};
    // Merge draft edits for this field over the persisted labels.
    const merged: Record<string, string> = { ...cur };
    for (const [k, v] of Object.entries(drafts)) {
      if (!k.startsWith(`${key}::`)) continue;
      const valKey = k.slice(key.length + 2);
      const trimmed = v.trim();
      if (trimmed) merged[valKey] = trimmed; else delete merged[valKey];
    }
    setSaving(true); setErr(null);
    try {
      const r = await fetch('/api/intel/enum-labels', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: coll, path, labels: merged }),
      });
      if (!r.ok) throw new Error(`save failed: ${r.status}`);
      const j = await r.json();
      const next = new Map(labels);
      next.set(key, j.labels as Record<string, string>);
      setLabels(next);
      // Drop drafts for this field so the inputs re-render from persisted state.
      setDrafts(d => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(d)) if (!k.startsWith(`${key}::`)) out[k] = v;
        return out;
      });
      setEditing(null);
      setSavedFlash(key);
      setTimeout(() => setSavedFlash(f => (f === key ? null : f)), 1500);
    } catch (e) { setErr(e instanceof Error ? e.message : 'save failed'); }
    finally { setSaving(false); }
  }

  function draftFor(coll: string, path: string, value: string): string {
    const dk = `${coll}.${path}::${value}`;
    if (dk in drafts) return drafts[dk];
    return labels.get(`${coll}.${path}`)?.[value] ?? '';
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button type="button" className="btn-ghost btn-sm" disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPopover())}
        title="Show enum values and definitions">
        ⓘ Enums
      </button>
      {open && (
        <div className="absolute z-30 bottom-full mb-2 right-0 w-[min(520px,92vw)] card shadow-elev-1 max-h-[480px] flex flex-col overflow-hidden">
          <div className="p-2 border-b border-line flex items-center gap-2">
            <input autoFocus className="input input-sm flex-1" placeholder="Search collection, field, or value…"
              value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && <div className="p-3 text-xs text-muted">Loading enums…</div>}
            {err && <div className="p-3 text-xs text-err">{err}</div>}
            {!loading && !err && rows.length === 0 && (
              <div className="p-3 text-xs text-muted">
                No enum-like fields found. Run Intelligence → Analyze on a collection to discover them.
              </div>
            )}
            {rows.map(({ coll, field }) => {
              const key = `${coll}.${field.name}`;
              const isEditing = editing === key;
              const stored = labels.get(key) ?? {};
              return (
                <div key={key} className="border-b border-line/60 last:border-b-0 px-3 py-2">
                  <div className="flex items-center justify-between">
                    <div className="font-mono text-xs text-ink">
                      <span className="text-muted">{coll}.</span>{field.name}
                    </div>
                    <div className="flex items-center gap-2">
                      {savedFlash === key && <span className="text-2xs text-accent-hi">saved</span>}
                      {isEditing ? (
                        <>
                          <button type="button" className="btn-ghost btn-sm" disabled={saving}
                            onClick={() => { setEditing(null); setDrafts(d => {
                              const out: Record<string, string> = {};
                              for (const [k, v] of Object.entries(d)) if (!k.startsWith(`${key}::`)) out[k] = v;
                              return out;
                            }); }}>Cancel</button>
                          <button type="button" className="btn-primary btn-sm" disabled={saving}
                            onClick={() => saveField(coll, field.name)}>{saving ? 'Saving…' : 'Save'}</button>
                        </>
                      ) : (
                        <button type="button" className="btn-ghost btn-sm"
                          onClick={() => setEditing(key)}>Edit</button>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
                    {(field.enumValues ?? []).map(v => {
                      const vk = String(v);
                      const def = stored[vk];
                      return (
                        <div key={vk} className="contents">
                          <span className="font-mono text-2xs text-ink-2 self-center whitespace-nowrap">{vk}</span>
                          {isEditing ? (
                            <input className="input input-sm" dir="auto"
                              placeholder="short definition (e.g. Order fully settled)"
                              value={draftFor(coll, field.name, vk)}
                              onChange={e => setDrafts(d => ({ ...d, [`${key}::${vk}`]: e.target.value }))} />
                          ) : (
                            <span className="text-xs text-muted truncate" title={def || 'no definition yet'}>
                              {def || <em className="text-2xs">— no definition —</em>}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
