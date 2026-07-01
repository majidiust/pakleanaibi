'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// A single attached field reference. The agent receives these as an
// "[Attached fields]" block appended to the user message, so the model has
// an explicit hint about which schema fields the analyst expects to drive
// the query. Stored in a flat shape so it's trivial to serialize.
//
// `values` is set when the analyst pinned specific enum values (e.g. state
// = "paid" | "pending"). The chat hint block renders these as an explicit
// "values in: ..." line so the LLM builds an $eq or $in filter using the
// exact spellings from the source data. Absent when the field is not
// enum-like or when the analyst attached the field for column selection
// only (no value constraint).
export interface AttachedField {
  collection: string;
  path: string;
  type: string;
  values?: (string | number | boolean)[];
}

interface SchemaField {
  name: string;
  types: string[];
  enumValues?: (string | number | boolean)[];
}
interface SchemaColl  { name: string; count: number; fields: SchemaField[] }
interface SchemaDigest { collections: SchemaColl[] }

// Module-scoped cache so the popover doesn't refetch the digest on each
// open. The /api/reports/schema route is already cached server-side with
// a 30-min TTL; keeping a local copy avoids a network round-trip every
// time the analyst clicks "+ Field".
let _digestCache: SchemaDigest | null = null;
let _digestPromise: Promise<SchemaDigest> | null = null;
async function loadDigest(): Promise<SchemaDigest> {
  if (_digestCache) return _digestCache;
  if (_digestPromise) return _digestPromise;
  _digestPromise = (async () => {
    const r = await fetch('/api/reports/schema');
    if (!r.ok) throw new Error('failed to load schema');
    const j = await r.json();
    _digestCache = j.digest as SchemaDigest;
    return _digestCache;
  })().finally(() => { _digestPromise = null; });
  return _digestPromise;
}

export function FieldAttacher({ attached, onChange, disabled }: {
  attached: AttachedField[];
  onChange: (next: AttachedField[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [digest, setDigest] = useState<SchemaDigest | null>(_digestCache);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Click-outside + Esc to close the popover.
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

  const openPopover = useCallback(async () => {
    setOpen(true);
    if (digest || loading) return;
    setLoading(true); setErr(null);
    try { setDigest(await loadDigest()); }
    catch (e) { setErr(e instanceof Error ? e.message : 'failed to load schema'); }
    finally { setLoading(false); }
  }, [digest, loading]);

  // Filter collections + fields by the search query. We match against the
  // collection name AND any of its field paths so a query like "date" still
  // surfaces the collection that owns a `dCreateDate` field.
  const filtered = useMemo(() => {
    if (!digest) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return digest.collections;
    return digest.collections
      .map(c => {
        const collHit = c.name.toLowerCase().includes(needle);
        const fields = c.fields.filter(f => f.name.toLowerCase().includes(needle));
        if (collHit) return c; // keep all fields when the collection itself matches
        if (fields.length) return { ...c, fields };
        return null;
      })
      .filter((c): c is SchemaColl => c !== null);
  }, [digest, q]);

  function isAttached(coll: string, path: string) {
    return attached.some(a => a.collection === coll && a.path === path);
  }
  function toggleField(coll: string, f: SchemaField) {
    if (isAttached(coll, f.name)) {
      onChange(attached.filter(a => !(a.collection === coll && a.path === f.name)));
    } else {
      onChange([...attached, { collection: coll, path: f.name, type: f.types[0] ?? 'unknown' }]);
    }
  }
  // Toggle a single enum value on an already-attached field. When the field
  // is not yet attached, attach it first so the user can pick a value in
  // one click. Deselecting the last value leaves the field attached with
  // `values` undefined (equivalent to "no constraint"), matching the
  // toggleField semantics.
  function toggleValue(coll: string, f: SchemaField, v: string | number | boolean) {
    const idx = attached.findIndex(a => a.collection === coll && a.path === f.name);
    if (idx === -1) {
      onChange([...attached, { collection: coll, path: f.name, type: f.types[0] ?? 'unknown', values: [v] }]);
      return;
    }
    const cur = attached[idx];
    const curVals = cur.values ?? [];
    const has = curVals.some(x => x === v);
    const nextVals = has ? curVals.filter(x => x !== v) : [...curVals, v];
    const nextItem: AttachedField = { ...cur, values: nextVals.length ? nextVals : undefined };
    const next = attached.slice();
    next[idx] = nextItem;
    onChange(next);
  }
  function getAttachedValues(coll: string, path: string): (string | number | boolean)[] {
    return attached.find(a => a.collection === coll && a.path === path)?.values ?? [];
  }

  return (
    <div className="relative" ref={wrapRef}>
      <button type="button" className="btn-ghost btn-sm" disabled={disabled}
        onClick={() => (open ? setOpen(false) : openPopover())}
        title="Attach schema fields to help the agent build the query">
        + Field{attached.length > 0 ? ` · ${attached.length}` : ''}
      </button>
      {open && (
        <div className="absolute z-30 bottom-full mb-2 right-0 w-[min(440px,90vw)] card shadow-elev-1 max-h-[420px] flex flex-col overflow-hidden">
          <div className="p-2 border-b border-line">
            <input autoFocus className="input input-sm" placeholder="Search collection or field…"
              value={q} onChange={e => setQ(e.target.value)} />
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading && <div className="p-3 text-xs text-muted">Loading schema…</div>}
            {err && <div className="p-3 text-xs text-err">{err}</div>}
            {!loading && !err && filtered.length === 0 && (
              <div className="p-3 text-xs text-muted">No matches.</div>
            )}
            {filtered.map(c => {
              const isOpen = expanded === c.name || !!q.trim();
              return (
                <div key={c.name} className="border-b border-line/60 last:border-b-0">
                  <button type="button" className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-panel2/60"
                    onClick={() => setExpanded(expanded === c.name ? null : c.name)}>
                    <span className="font-mono text-xs text-ink">{c.name}</span>
                    <span className="text-2xs text-muted">{c.fields.length} fields · ~{c.count}</span>
                  </button>
                  {isOpen && (
                    <div className="px-2 pb-2 grid grid-cols-1 gap-0.5">
                      {c.fields.map(f => {
                        const on = isAttached(c.name, f.name);
                        const hasEnum = Array.isArray(f.enumValues) && f.enumValues.length > 0;
                        const picked = hasEnum ? getAttachedValues(c.name, f.name) : [];
                        return (
                          <div key={f.name}>
                            <button type="button"
                              className={`w-full flex items-center justify-between gap-2 px-2 py-1 rounded text-left text-xs hover:bg-panel2 ${on ? 'bg-accent/15 border border-accent-lo/40' : 'border border-transparent'}`}
                              onClick={() => toggleField(c.name, f)}>
                              <span className="font-mono text-ink-2 truncate">
                                {f.name}
                                {hasEnum && <span className="ml-1 text-2xs text-accent-hi">enum</span>}
                              </span>
                              <span className="text-2xs text-muted shrink-0">{f.types.join('|')}{on ? ' \u2713' : ''}</span>
                            </button>
                            {hasEnum && (
                              // Value chips: click to pin one or more enum
                              // values for this field. First click also
                              // attaches the field so the analyst doesn't
                              // have to attach + pick in two steps.
                              <div className="pl-3 pr-1 pt-1 pb-1 flex flex-wrap gap-1">
                                {f.enumValues!.map(v => {
                                  const isPicked = picked.some(x => x === v);
                                  return (
                                    <button key={String(v)} type="button"
                                      className={`text-2xs font-mono px-1.5 py-0.5 rounded border ${isPicked ? 'bg-accent/25 border-accent-lo text-ink' : 'bg-panel2/40 border-line text-ink-2 hover:bg-panel2'}`}
                                      onClick={() => toggleValue(c.name, f, v)}
                                      title={isPicked ? 'Remove filter value' : 'Filter on this value'}>
                                      {String(v)}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {attached.length > 0 && (
            <div className="p-2 border-t border-line flex items-center justify-between text-2xs text-muted">
              <span>{attached.length} attached</span>
              <button type="button" className="link" onClick={() => onChange([])}>Clear all</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
