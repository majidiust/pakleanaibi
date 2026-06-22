// Client-side export helpers for tabular data. Both formats stream a single
// file to the user via a temporary blob URL — no server roundtrip needed,
// since the rows are already in memory after a query run.
//
// XLSX: built with exceljs because the npm-published `xlsx` package is no
// longer kept in sync with upstream. exceljs produces a proper .xlsx file
// (Excel opens it without the "from unknown source" warning).
// PDF: jsPDF + autotable. Landscape, repeating header, auto-shrunk columns.

function flatten(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch { return '[object]'; }
  }
  return String(v);
}

function pickColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  // Sample up to 200 rows to discover all column keys, preserving the first
  // observed order so the spreadsheet/PDF columns line up with what the UI
  // displays.
  for (const r of rows.slice(0, 200)) {
    for (const k of Object.keys(r)) seen.add(k);
  }
  return [...seen];
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has time to commit the download.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function exportXlsx(
  rows: Record<string, unknown>[],
  filename: string,
  sheetName = 'Report',
): Promise<void> {
  // exceljs is imported dynamically so the ~400KB library only loads when
  // the user actually exports something.
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Paklean BI';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName.slice(0, 31) || 'Report');
  const columns = pickColumns(rows);
  ws.columns = columns.map(k => ({ header: k, key: k, width: Math.min(40, Math.max(12, k.length + 4)) }));
  // Header styling: subtle accent fill + bold text so it stands out without
  // looking like a stock spreadsheet template.
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5457E0' },
  };
  ws.getRow(1).alignment = { vertical: 'middle' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of rows) {
    const out: Record<string, unknown> = {};
    for (const k of columns) {
      const v = r[k];
      if (v instanceof Date) out[k] = v;
      else if (v && typeof v === 'object') out[k] = flatten(v);
      else out[k] = v ?? '';
    }
    ws.addRow(out);
  }
  // Auto-filter so users can sort/filter in Excel without extra setup.
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(1, columns.length) },
  };
  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

export async function exportPdf(
  rows: Record<string, unknown>[],
  filename: string,
  title = 'Report',
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const columns = pickColumns(rows);
  const body = rows.map(r => columns.map(k => flatten(r[k])));

  // Title strip
  doc.setFontSize(14);
  doc.setTextColor(20, 20, 24);
  doc.text(title, 40, 32);
  doc.setFontSize(9);
  doc.setTextColor(110, 110, 122);
  doc.text(
    `${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'} • exported ${new Date().toLocaleString()}`,
    40, 48,
  );

  autoTable(doc, {
    startY: 60,
    head: [columns],
    body,
    styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak', valign: 'top' },
    headStyles: { fillColor: [84, 87, 224], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 248, 251] },
    margin: { top: 60, left: 28, right: 28, bottom: 32 },
    didDrawPage: (data) => {
      // Page footer with page number.
      const pageNo = doc.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(140);
      doc.text(
        `Page ${data.pageNumber} of ${pageNo}`,
        doc.internal.pageSize.getWidth() - 80, doc.internal.pageSize.getHeight() - 16,
      );
    },
  });
  doc.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
}

export function sanitizeFilename(s: string): string {
  return (s || 'report').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(0, 80);
}
