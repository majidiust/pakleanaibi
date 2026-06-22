'use client';
// Dialog that lets the user choose Excel/PDF, how many rows to export, and
// (optionally) a filename. Defaults to all rows currently in memory. Lazy
// imports the export helpers so the heavy libraries (~400KB) only load when
// the user actually requests an export.
import { useEffect, useState } from 'react';

type Format = 'xlsx' | 'pdf';

export function ExportModal({
  rows, defaultTitle, onClose,
}: {
  rows: Record<string, unknown>[];
  defaultTitle?: string;
  onClose: () => void;
}) {
  const total = rows.length;
  const [format, setFormat] = useState<Format>('xlsx');
  const [scope, setScope] = useState<'all' | 'custom'>('all');
  const [count, setCount] = useState<number>(Math.min(total, 1000));
  const [title, setTitle] = useState<string>(defaultTitle ?? 'report');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Clamp the custom-count input to the available row count whenever the
  // dataset changes so the field can't propose an export of N>total rows.
  useEffect(() => {
    setCount(c => Math.max(1, Math.min(c, total || 1)));
  }, [total]);

  async function run() {
    if (total === 0) { setErr('Nothing to export.'); return; }
    setBusy(true); setErr(null);
    try {
      const n = scope === 'all' ? total : Math.max(1, Math.min(count, total));
      const slice = rows.slice(0, n);
      const { exportXlsx, exportPdf, sanitizeFilename } = await import('@/lib/export');
      const safe = sanitizeFilename(title);
      if (format === 'xlsx') await exportXlsx(slice, safe, defaultTitle || 'Report');
      else                    await exportPdf(slice,  safe, defaultTitle || 'Report');
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'export_failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg/70 backdrop-blur-sm grid place-items-center p-4"
         onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card card-pad w-full max-w-md space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-base font-semibold tracking-tightish">Export data</div>
            <div className="text-xs text-muted mt-0.5">
              <span className="text-ink-2 font-medium num">{total.toLocaleString()}</span> row{total === 1 ? '' : 's'} available in this result set.
            </div>
          </div>
          <button className="btn-subtle btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="space-y-2">
          <label className="label">Format</label>
          <div className="grid grid-cols-2 gap-2">
            <FormatChip active={format === 'xlsx'} onClick={() => setFormat('xlsx')} label="Excel (.xlsx)" hint="Spreadsheet, auto-filter" />
            <FormatChip active={format === 'pdf'}  onClick={() => setFormat('pdf')}  label="PDF"          hint="Landscape, printable" />
          </div>
        </div>

        <div className="space-y-2">
          <label className="label">Records to export</label>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} />
              <span>All rows <span className="text-muted-2 num">({total.toLocaleString()})</span></span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input type="radio" checked={scope === 'custom'} onChange={() => setScope('custom')} />
              <span>First</span>
              <input
                type="number" min={1} max={total || 1} step={1}
                className="input input-sm w-28 num" value={count}
                onFocus={() => setScope('custom')}
                onChange={e => setCount(Math.max(1, Math.min(Number(e.target.value) || 1, total || 1)))} />
              <span>rows</span>
            </label>
          </div>
        </div>

        <div className="space-y-2">
          <label className="label">Filename</label>
          <input className="input input-sm" value={title} onChange={e => setTitle(e.target.value)}
                 placeholder="report" maxLength={80} />
          <div className="text-2xs text-muted-2">
            Will be saved as <span className="font-mono">{(title || 'report').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_')}.{format}</span>
          </div>
        </div>

        {err && <div className="text-xs text-err">{err}</div>}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
          <button className="btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={run} disabled={busy || total === 0}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FormatChip({ active, onClick, label, hint }: {
  active: boolean; onClick: () => void; label: string; hint: string;
}) {
  return (
    <button type="button" onClick={onClick}
      className={`text-left rounded-lg border px-3 py-2 transition-colors ${
        active
          ? 'border-accent bg-accent/10 text-ink'
          : 'border-line bg-panel2/40 text-muted hover:text-ink hover:border-line-2'
      }`}>
      <div className="text-sm font-medium">{label}</div>
      <div className="text-2xs text-muted-2 mt-0.5">{hint}</div>
    </button>
  );
}
