'use client';
import { useState, useMemo } from 'react';

// Recursive structure-aware cell renderer for the agentic + saved-reports
// tables. The previous implementation stringified every non-scalar to JSON,
// which is unreadable for nested documents (orderitems arrays, $lookup
// joined sub-docs, etc.). This component classifies each value and picks a
// presentation: scalar text, formatted date, short ObjectId pill,
// expandable key/value view for plain objects, chip row for scalar arrays,
// and a nested mini-table for arrays of objects.

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const OID_RE = /^[a-f0-9]{24}$/i;

function classify(v: unknown): 'null'|'bool'|'number'|'date'|'oid'|'string'|'object'|'scalarArr'|'objectArr'|'emptyArr'|'mixedArr' {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'number';
  if (v instanceof Date) return 'date';
  if (typeof v === 'string') {
    if (ISO_DATE_RE.test(v)) return 'date';
    if (OID_RE.test(v)) return 'oid';
    return 'string';
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return 'emptyArr';
    const kinds = new Set(v.map(x => (x !== null && typeof x === 'object' && !(x instanceof Date)) ? 'obj' : 'scalar'));
    if (kinds.size > 1) return 'mixedArr';
    return kinds.has('obj') ? 'objectArr' : 'scalarArr';
  }
  if (typeof v === 'object') return 'object';
  return 'string';
}

function fmtDate(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(d.getTime())) return String(v);
  // Show seconds only when non-zero so the common "midnight cutoff" case stays compact.
  const hasTime = d.getUTCHours() + d.getUTCMinutes() + d.getUTCSeconds() > 0;
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear(), mo = pad(d.getUTCMonth() + 1), da = pad(d.getUTCDate());
  if (!hasTime) return `${y}-${mo}-${da}`;
  return `${y}-${mo}-${da} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return n.toLocaleString();
  // Trim trailing zeroes on decimals while keeping precision.
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function CellValue({ v, depth = 0 }: { v: unknown; depth?: number }) {
  const kind = classify(v);
  const [expanded, setExpanded] = useState(false);

  switch (kind) {
    case 'null':
      return <span className="text-muted-2">—</span>;
    case 'bool':
      return <span className={`pill ${v ? 'pill-ok' : 'pill-warn'}`}>{String(v)}</span>;
    case 'number':
      return <span className="num text-xs text-ink-2">{fmtNumber(v as number)}</span>;
    case 'date':
      return <span className="num text-xs text-ink-2" title={v instanceof Date ? v.toISOString() : String(v)}>{fmtDate(v)}</span>;
    case 'oid': {
      const s = String(v);
      return <span className="font-mono text-2xs text-muted" title={s}>{s.slice(0, 6)}…{s.slice(-4)}</span>;
    }
    case 'string': {
      const s = v as string;
      if (s.length <= 80) return <span dir="auto" className="text-xs text-ink-2 whitespace-pre-wrap">{s}</span>;
      return (
        <span dir="auto" className="text-xs text-ink-2 whitespace-pre-wrap">
          {expanded ? s : s.slice(0, 80) + '…'}
          <button type="button" className="ml-1 text-2xs link" onClick={() => setExpanded(e => !e)}>
            {expanded ? 'less' : 'more'}
          </button>
        </span>
      );
    }
    case 'emptyArr':
      return <span className="text-muted-2 text-2xs">[ ]</span>;
    case 'scalarArr':
      return <ScalarArray items={v as unknown[]} />;
    case 'objectArr':
      return <NestedTable rows={v as Record<string, unknown>[]} depth={depth} />;
    case 'mixedArr':
      return <MixedArray items={v as unknown[]} depth={depth} />;
    case 'object':
      return <ObjectView obj={v as Record<string, unknown>} depth={depth} />;
  }
}

function ScalarArray({ items }: { items: unknown[] }) {
  const [open, setOpen] = useState(false);
  const VIS = 8;
  const visible = open ? items : items.slice(0, VIS);
  const more = items.length - visible.length;
  return (
    <span className="inline-flex flex-wrap gap-1 items-center">
      {visible.map((x, i) => (
        <span key={i} className="pill"><CellValue v={x} /></span>
      ))}
      {more > 0 && (
        <button type="button" className="text-2xs link" onClick={() => setOpen(o => !o)}>
          {open ? 'less' : `+${more} more`}
        </button>
      )}
    </span>
  );
}

function MixedArray({ items, depth }: { items: unknown[]; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  return (
    <div className="space-y-0.5">
      <button type="button" className="text-2xs link" onClick={() => setOpen(o => !o)}>
        {open ? '▾' : '▸'} {items.length} item{items.length === 1 ? '' : 's'}
      </button>
      {open && (
        <ol className="list-decimal list-inside space-y-0.5 pl-1">
          {items.map((x, i) => <li key={i} className="text-xs text-ink-2"><CellValue v={x} depth={depth + 1} /></li>)}
        </ol>
      )}
    </div>
  );
}

function ObjectView({ obj, depth }: { obj: Record<string, unknown>; depth: number }) {
  const entries = useMemo(() => Object.entries(obj).filter(([, val]) => val !== undefined), [obj]);
  // Auto-expand at the top level so the analyst doesn't have to click to see
  // a single-object cell; collapse by default once we're already inside a
  // nested structure to keep the parent cell scannable.
  const [open, setOpen] = useState(depth < 1);
  if (entries.length === 0) return <span className="text-muted-2 text-2xs">{`{ }`}</span>;
  return (
    <div className="space-y-0.5">
      <button type="button" className="text-2xs link" onClick={() => setOpen(o => !o)}>
        {open ? '▾' : '▸'} {entries.length} field{entries.length === 1 ? '' : 's'}
      </button>
      {open && (
        <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 pl-1 border-l border-line/60 ml-0.5">
          {entries.map(([k, val]) => (
            <div key={k} className="contents">
              <span className="text-2xs text-muted font-mono whitespace-nowrap pt-0.5">{k}</span>
              <span className="text-xs"><CellValue v={val} depth={depth + 1} /></span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NestedTable({ rows, depth }: { rows: Record<string, unknown>[]; depth: number }) {
  // Compute a stable column order by sampling the first ~10 rows and using
  // the union of their keys in first-seen order. This handles ragged arrays
  // (e.g. orderitems with optional fields) without exploding into 50 cols.
  const cols = useMemo(() => {
    const out: string[] = []; const seen = new Set<string>();
    for (const r of rows.slice(0, 10)) {
      if (!r || typeof r !== 'object') continue;
      for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
    return out.slice(0, 12);
  }, [rows]);
  const PAGE = 5;
  const [shown, setShown] = useState(Math.min(PAGE, rows.length));
  const visible = rows.slice(0, shown);
  return (
    <div className="space-y-1">
      <div className="text-2xs text-muted">{rows.length} row{rows.length === 1 ? '' : 's'}</div>
      <div className="rounded border border-line/60 overflow-hidden">
        <table className="w-full text-2xs">
          <thead className="bg-panel2/60">
            <tr>{cols.map(c => <th key={c} className="text-left font-mono text-muted px-1.5 py-1 whitespace-nowrap">{c}</th>)}</tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={i} className="border-t border-line/40">
                {cols.map(c => (
                  <td key={c} className="px-1.5 py-1 align-top"><CellValue v={r?.[c]} depth={depth + 1} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown < rows.length && (
        <button type="button" className="text-2xs link" onClick={() => setShown(s => Math.min(rows.length, s + PAGE * 2))}>
          show {Math.min(PAGE * 2, rows.length - shown)} more (of {rows.length})
        </button>
      )}
      {shown > PAGE && (
        <button type="button" className="text-2xs link ml-2" onClick={() => setShown(Math.min(PAGE, rows.length))}>
          collapse
        </button>
      )}
    </div>
  );
}
