'use client';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Field { path: string; types: string[]; presence: number }
interface Props {
  name: string;
  fields: Field[];
  initialDocCount: number;
}

// Tagged wire-format produced by /api/intel/collections/[name]/data.
type Tagged = { __t: 'date' | 'oid' | 'dec' | 'long' | 'bin'; v: string };
function isTagged(v: unknown): v is Tagged {
  return !!v && typeof v === 'object' && '__t' in (v as object) && 'v' in (v as object);
}

function formatCell(v: unknown): { text: string; mono: boolean; muted: boolean } {
  if (v === null) return { text: 'null', mono: true, muted: true };
  if (v === undefined) return { text: '—', mono: false, muted: true };
  if (isTagged(v)) {
    if (v.__t === 'date') {
      const d = new Date(v.v);
      return { text: isNaN(d.getTime()) ? v.v : d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z'), mono: true, muted: false };
    }
    if (v.__t === 'oid') return { text: v.v, mono: true, muted: false };
    return { text: v.v, mono: true, muted: false };
  }
  if (Array.isArray(v)) return { text: `[${v.length}] ` + JSON.stringify(v).slice(0, 120), mono: true, muted: true };
  if (typeof v === 'object') return { text: JSON.stringify(v).slice(0, 140), mono: true, muted: true };
  if (typeof v === 'boolean') return { text: v ? 'true' : 'false', mono: true, muted: false };
  if (typeof v === 'number') return { text: String(v), mono: true, muted: false };
  return { text: String(v), mono: false, muted: false };
}

export function CollectionDataBrowser({ name, fields, initialDocCount }: Props) {
  // Top-level columns ordered by presence; _id always first, others ranked.
  const allCols = useMemo(() => {
    const top = fields.filter(f => !f.path.includes('.'));
    const sorted = [...top].sort((a, b) => {
      if (a.path === '_id') return -1;
      if (b.path === '_id') return 1;
      return b.presence - a.presence;
    });
    return sorted.map(f => f.path);
  }, [fields]);

  const defaultVisible = useMemo(() => allCols.slice(0, 8), [allCols]);
  const [visible, setVisible] = useState<string[]>(defaultVisible);
  const [showPicker, setShowPicker] = useState(false);

  const [skip, setSkip] = useState(0);
  const [limit, setLimit] = useState(25);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: '_id', dir: -1 });
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [total, setTotal] = useState(initialDocCount);
  const [totalExact, setTotalExact] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async (opts: { skip: number; limit: number; sort: { key: string; dir: 1 | -1 }; exact?: boolean }) => {
    const my = ++reqId.current;
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({
        skip: String(opts.skip), limit: String(opts.limit),
        sort: opts.sort.key, dir: String(opts.sort.dir),
        ...(opts.exact ? { exact: '1' } : {}),
      });
      const r = await fetch(`/api/intel/collections/${encodeURIComponent(name)}/data?${qs}`);
      if (my !== reqId.current) return;
      if (!r.ok) { setError((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`); setRows([]); return; }
      const j = await r.json();
      setRows(j.rows ?? []);
      setTotal(j.total ?? 0);
      setTotalExact(!!j.totalIsExact);
    } catch (e) {
      if (my !== reqId.current) return;
      setError(e instanceof Error ? e.message : 'fetch failed');
    } finally {
      if (my === reqId.current) setLoading(false);
    }
  }, [name]);

  useEffect(() => { void load({ skip, limit, sort }); }, [load, skip, limit, sort]);

  function toggleSort(key: string) {
    setSkip(0);
    setSort(s => s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 });
  }
  function toggleCol(c: string) {
    setVisible(v => v.includes(c) ? v.filter(x => x !== c) : [...v, c]);
  }

  const filteredRows = useMemo(() => {
    if (!filter.trim()) return rows;
    const f = filter.toLowerCase();
    return rows.filter(r => visible.some(k => {
      const c = formatCell(r[k]);
      return c.text.toLowerCase().includes(f);
    }));
  }, [rows, filter, visible]);

  const pageStart = total === 0 ? 0 : skip + 1;
  const pageEnd = Math.min(total, skip + rows.length);
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const pageIdx = Math.floor(skip / limit) + 1;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <svg viewBox="0 0 20 20" className="size-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-2"
              fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <circle cx="9" cy="9" r="5.5" /><path d="m17 17-3.5-3.5" />
            </svg>
            <input className="input input-sm pl-8 w-64" placeholder="Filter loaded page…"
              value={filter} onChange={e => setFilter(e.target.value)} />
          </div>
          <div className="relative">
            <button className="btn-ghost btn-sm" onClick={() => setShowPicker(p => !p)} type="button">
              Columns ({visible.length}/{allCols.length})
            </button>
            {showPicker && (
              <div className="absolute z-20 mt-1 w-64 max-h-72 overflow-auto card card-pad p-2 space-y-1 shadow-elev-3">
                {allCols.map(c => (
                  <label key={c} className="flex items-center gap-2 text-xs px-1.5 py-1 rounded hover:bg-panel2 cursor-pointer">
                    <input type="checkbox" checked={visible.includes(c)} onChange={() => toggleCol(c)} />
                    <span className="font-mono truncate">{c}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <select className="input input-sm w-auto" value={limit}
            onChange={e => { setSkip(0); setLimit(Number(e.target.value)); }}>
            {[10, 25, 50, 100, 200].map(n => <option key={n} value={n}>{n} / page</option>)}
          </select>
        </div>
        <div className="text-xs text-muted num">
          {loading ? <span className="text-ink-2">Loading…</span> : (
            <>
              <span className="text-ink-2 font-medium">{pageStart.toLocaleString()}–{pageEnd.toLocaleString()}</span>
              <span className="mx-1">of</span>
              <span className="text-ink-2 font-medium">{total.toLocaleString()}</span>
              {!totalExact && (
                <button className="ml-1 link" type="button"
                  onClick={() => load({ skip, limit, sort, exact: true })}>(estimated · exact?)</button>
              )}
            </>
          )}
        </div>
      </div>

      {error && <div className="card card-pad text-err text-sm">{error}</div>}

      <div className="table-wrap">
        <table className="bi">
          <thead>
            <tr>
              <th className="w-6"></th>
              {visible.map(c => {
                const active = sort.key === c;
                return (
                  <th key={c} onClick={() => toggleSort(c)} className="cursor-pointer hover:text-ink-2">
                    <span className="inline-flex items-center gap-1">
                      <span className="font-mono normal-case tracking-normal text-ink-2">{c}</span>
                      {active && (
                        <svg viewBox="0 0 12 12" className="size-3 text-accent-hi" fill="currentColor">
                          {sort.dir === 1 ? <path d="M6 3l4 5H2z" /> : <path d="M6 9 2 4h8z" />}
                        </svg>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 && !loading && (
              <tr><td colSpan={visible.length + 1} className="text-center text-muted py-6">No documents.</td></tr>
            )}
            {filteredRows.map((r, i) => (
              <Fragment key={i}>
                <tr onClick={() => setExpanded(expanded === i ? null : i)} className="cursor-pointer">
                  <td className="text-muted-2">
                    <svg viewBox="0 0 12 12" className={`size-3 transition-transform ${expanded === i ? 'rotate-90' : ''}`}
                      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      <path d="m4.5 2 3.5 4-3.5 4" />
                    </svg>
                  </td>
                  {visible.map(c => {
                    const cell = formatCell(r[c]);
                    return (
                      <td key={c} className={`${cell.mono ? 'font-mono text-xs' : 'text-sm'} ${cell.muted ? 'text-muted' : ''} max-w-xs truncate`}>
                        {cell.text}
                      </td>
                    );
                  })}
                </tr>
                {expanded === i && (
                  <tr>
                    <td colSpan={visible.length + 1} className="bg-panel2/40">
                      <pre className="text-xs font-mono overflow-x-auto whitespace-pre-wrap p-2 text-ink-2">{JSON.stringify(r, null, 2)}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between items-center gap-2 text-sm">
        <div className="text-xs text-muted">
          Page <span className="text-ink-2 num">{pageIdx}</span>
          <span className="mx-1">/</span>
          <span className="text-ink-2 num">{pageCount.toLocaleString()}</span>
        </div>
        <div className="flex items-center gap-1">
          <button className="btn-ghost btn-sm" disabled={skip === 0 || loading} onClick={() => setSkip(0)}>« First</button>
          <button className="btn-ghost btn-sm" disabled={skip === 0 || loading} onClick={() => setSkip(Math.max(0, skip - limit))}>
            <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m7.5 2-3.5 4 3.5 4" /></svg>
            Prev
          </button>
          <button className="btn-ghost btn-sm" disabled={skip + limit >= total || loading} onClick={() => setSkip(skip + limit)}>
            Next
            <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m4.5 2 3.5 4-3.5 4" /></svg>
          </button>
        </div>
      </div>
    </div>
  );
}
