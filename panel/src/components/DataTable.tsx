'use client';
import { useMemo, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ExportModal } from './ExportModal';
import { CellValue } from './CellValue';

export function DataTable({ rows, title }: { rows: Record<string, unknown>[]; title?: string }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState('');
  const [showExport, setShowExport] = useState(false);

  const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
    const keys = new Set<string>();
    for (const r of rows.slice(0, 50)) Object.keys(r).forEach(k => keys.add(k));
    return [...keys].map(k => ({
      accessorKey: k,
      header: k,
      cell: info => <CellValue v={info.getValue()} />,
      sortingFn: 'auto',
    }));
  }, [rows]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 25 } },
  });

  const filteredRows = table.getFilteredRowModel().rows;
  const filtered = filteredRows.length;
  const pageIdx = table.getState().pagination.pageIndex;
  const pageCount = table.getPageCount() || 1;

  // Export operates on the currently filtered + sorted view so the user gets
  // exactly what they see in the UI, not the raw upstream array.
  const exportRows = useMemo(
    () => filteredRows.map(r => r.original as Record<string, unknown>),
    [filteredRows],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="relative max-w-xs w-full">
          <svg viewBox="0 0 20 20" className="size-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-2"
            fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="9" cy="9" r="5.5" /><path d="m17 17-3.5-3.5" />
          </svg>
          <input className="input pl-8" placeholder="Filter rows…" value={filter}
            onChange={e => setFilter(e.target.value)} />
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-muted num">
            <span className="text-ink-2 font-medium">{filtered.toLocaleString()}</span>
            <span className="mx-1">of</span>
            <span className="text-ink-2 font-medium">{rows.length.toLocaleString()}</span>
            <span className="ml-1">rows</span>
          </div>
          <button className="btn-ghost btn-sm" onClick={() => setShowExport(true)} disabled={rows.length === 0}
                  title="Export to Excel or PDF">
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2v8m0 0 3-3m-3 3L5 7M2.5 11v1.5A1.5 1.5 0 0 0 4 14h8a1.5 1.5 0 0 0 1.5-1.5V11" />
            </svg>
            Export
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="bi">
          <thead>
            {table.getHeaderGroups().map(g => (
              <tr key={g.id}>{g.headers.map(h => {
                const dir = h.column.getIsSorted();
                return (
                  <th key={h.id} onClick={h.column.getToggleSortingHandler()} className="cursor-pointer hover:text-ink-2">
                    <span className="inline-flex items-center gap-1">
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      {dir && (
                        <svg viewBox="0 0 12 12" className="size-3 text-accent-hi" fill="currentColor">
                          {dir === 'asc'
                            ? <path d="M6 3l4 5H2z" />
                            : <path d="M6 9 2 4h8z" />}
                        </svg>
                      )}
                    </span>
                  </th>
                );
              })}</tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map(r => (
              <tr key={r.id}>{r.getVisibleCells().map(c => (
                <td key={c.id}>{flexRender(c.column.columnDef.cell, c.getContext())}</td>
              ))}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-between items-center gap-2 text-sm">
        <div className="text-xs text-muted">
          Page <span className="text-ink-2 num">{pageIdx + 1}</span>
          <span className="mx-1">/</span>
          <span className="text-ink-2 num">{pageCount}</span>
        </div>
        <div className="flex items-center gap-1">
          <button className="btn-ghost btn-sm" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
            <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m7.5 2-3.5 4 3.5 4" /></svg>
            Prev
          </button>
          <button className="btn-ghost btn-sm" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
            Next
            <svg viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="m4.5 2 3.5 4-3.5 4" /></svg>
          </button>
        </div>
      </div>
      {showExport && (
        <ExportModal
          rows={exportRows}
          defaultTitle={title}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}
