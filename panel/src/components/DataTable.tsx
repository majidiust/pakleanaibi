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

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function DataTable({ rows }: { rows: Record<string, unknown>[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [filter, setFilter] = useState('');

  const columns = useMemo<ColumnDef<Record<string, unknown>>[]>(() => {
    const keys = new Set<string>();
    for (const r of rows.slice(0, 50)) Object.keys(r).forEach(k => keys.add(k));
    return [...keys].map(k => ({
      accessorKey: k,
      header: k,
      cell: info => <span className="font-mono text-xs">{fmtCell(info.getValue())}</span>,
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

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <input className="input max-w-xs" placeholder="Filter rows…" value={filter}
          onChange={e => setFilter(e.target.value)} />
        <div className="text-xs text-muted">
          {table.getFilteredRowModel().rows.length} of {rows.length} rows
        </div>
      </div>
      <div className="table-wrap">
        <table className="bi">
          <thead>
            {table.getHeaderGroups().map(g => (
              <tr key={g.id}>{g.headers.map(h => {
                const dir = h.column.getIsSorted();
                return (
                  <th key={h.id} onClick={h.column.getToggleSortingHandler()} className="cursor-pointer">
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {dir === 'asc' ? ' ▲' : dir === 'desc' ? ' ▼' : ''}
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
      <div className="flex justify-end items-center gap-2 text-sm">
        <button className="btn-ghost" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>Prev</button>
        <span className="text-muted">
          Page {table.getState().pagination.pageIndex + 1} / {table.getPageCount() || 1}
        </span>
        <button className="btn-ghost" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>Next</button>
      </div>
    </div>
  );
}
