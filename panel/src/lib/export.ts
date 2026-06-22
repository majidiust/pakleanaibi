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

// --- Persian / Arabic support ---------------------------------------------
// jsPDF's default fonts cover Latin-1 only and the PDF text engine renders
// strictly LTR with no shaping. To make Farsi (and Arabic) legible in the
// exported PDF we (1) embed a font that ships Arabic glyphs, (2) convert
// each RTL string to its joined presentation forms using PersianShaper,
// and (3) reverse the result so the visual order matches RTL when drawn
// LTR. Latin segments inside a cell are not bidi-corrected — mixed-script
// cells will show the Latin run reversed; for typical BI data (cells are
// monolingual) the simple reversal is the standard pragmatic approach.

const RTL_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
export function containsRTL(s: string): boolean { return RTL_RE.test(s); }

let fontPromise: Promise<string | null> | null = null;
function loadVazirmatn(): Promise<string | null> {
  if (fontPromise) return fontPromise;
  fontPromise = (async () => {
    try {
      const res = await fetch('/fonts/Vazirmatn-Regular.ttf');
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      // Chunked btoa to avoid blowing the call stack on the spread operator.
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
      }
      return btoa(bin);
    } catch { return null; }
  })();
  return fontPromise;
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
  ws.views = [{ state: 'frozen', ySplit: 1, rightToLeft: columns.some(containsRTL) }];
  // Track which columns contain RTL values so we can right-align them; Excel
  // handles the shaping/bidi natively, we just need the column alignment.
  const rtlCols = new Set<string>();
  for (const r of rows) {
    const out: Record<string, unknown> = {};
    for (const k of columns) {
      const v = r[k];
      if (v instanceof Date) out[k] = v;
      else if (v && typeof v === 'object') out[k] = flatten(v);
      else out[k] = v ?? '';
      if (typeof out[k] === 'string' && containsRTL(out[k] as string)) rtlCols.add(k);
    }
    ws.addRow(out);
  }
  for (const k of rtlCols) {
    const col = ws.getColumn(k);
    if (col) col.alignment = { horizontal: 'right', vertical: 'middle', readingOrder: 'rtl' };
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
  const [{ jsPDF }, autoTableMod, fontB64, reshaperMod] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    loadVazirmatn(),
    import('arabic-persian-reshaper'),
  ]);
  const autoTable = autoTableMod.default;
  const shape = reshaperMod.PersianShaper.convertArabic.bind(reshaperMod.PersianShaper);
  // Reshape + reverse so RTL text reads correctly when drawn LTR by the
  // PDF text engine. No-op for cells without Arabic/Persian codepoints.
  const rtl = (s: string): string => containsRTL(s)
    ? [...shape(s)].reverse().join('') : s;

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });

  // Register Vazirmatn so the PDF actually contains the glyphs for Persian
  // codepoints. Fall back silently to Helvetica if the font file is
  // unreachable (offline build, blocked CDN) — at least the export still
  // succeeds with Latin text rendered correctly.
  const FONT = 'Vazirmatn';
  let fontReady = false;
  if (fontB64) {
    doc.addFileToVFS('Vazirmatn-Regular.ttf', fontB64);
    doc.addFont('Vazirmatn-Regular.ttf', FONT, 'normal');
    doc.setFont(FONT, 'normal');
    fontReady = true;
  }

  const columns = pickColumns(rows);
  const body = rows.map(r => columns.map(k => flatten(r[k])));

  // Title strip
  doc.setFontSize(14);
  doc.setTextColor(20, 20, 24);
  doc.text(rtl(title), 40, 32);
  doc.setFontSize(9);
  doc.setTextColor(110, 110, 122);
  doc.text(
    `${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'} • exported ${new Date().toLocaleString()}`,
    40, 48,
  );

  // Pre-shape headers and body so the table renders correctly. Keep track
  // of which body cells are RTL so we can right-align them in didParseCell
  // without re-scanning the (already reshaped) text.
  const headRow = columns.map(rtl);
  const rtlMask = body.map(row => row.map(containsRTL));
  const shapedBody = body.map((row, i) => row.map((c, j) => rtlMask[i][j] ? rtl(c) : c));
  const rtlHeader = columns.map(containsRTL);

  autoTable(doc, {
    startY: 60,
    head: [headRow],
    body: shapedBody,
    styles: {
      fontSize: 8, cellPadding: 4, overflow: 'linebreak', valign: 'top',
      ...(fontReady ? { font: FONT, fontStyle: 'normal' } : {}),
    },
    headStyles: {
      fillColor: [84, 87, 224], textColor: 255,
      ...(fontReady ? { font: FONT, fontStyle: 'normal' } : { fontStyle: 'bold' }),
    },
    alternateRowStyles: { fillColor: [248, 248, 251] },
    margin: { top: 60, left: 28, right: 28, bottom: 32 },
    didParseCell: (data) => {
      // Right-align cells whose original text is RTL so columns of Persian
      // values read naturally from the right edge.
      const isHead = data.section === 'head';
      const isRtl = isHead
        ? !!rtlHeader[data.column.index]
        : !!rtlMask[data.row.index]?.[data.column.index];
      if (isRtl) data.cell.styles.halign = 'right';
    },
    didDrawPage: (data) => {
      // Page footer with page number.
      const pageNo = doc.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(140);
      if (fontReady) doc.setFont(FONT, 'normal');
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
