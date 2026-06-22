// Tiny YAML serializer for flat-ish JS objects (no anchors, no flow style,
// no special tags). Sufficient for exporting schema/relationship metadata.
function indent(n: number) { return '  '.repeat(n); }

function quote(s: string): string {
  if (/^[\w./@:+-]+$/.test(s) && !/^(true|false|null|yes|no|on|off|\d)/i.test(s)) return s;
  return JSON.stringify(s);
}

function toYaml(v: unknown, depth = 0): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return quote(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return '\n' + v.map(x => `${indent(depth)}- ${toYaml(x, depth + 1).replace(/^\n/, '\n' + indent(depth + 1))}`).join('\n');
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, val]) => val !== undefined);
    if (entries.length === 0) return '{}';
    return '\n' + entries.map(([k, val]) => {
      const child = toYaml(val, depth + 1);
      const sep = child.startsWith('\n') ? ':' : ': ';
      return `${indent(depth)}${quote(k)}${sep}${child}`;
    }).join('\n');
  }
  return String(v);
}

export function toYamlDocument(v: unknown): string {
  const body = toYaml(v, 0);
  return (body.startsWith('\n') ? body.slice(1) : body) + '\n';
}

// Flat CSV writer for relationships. Headers are derived from the union of
// row keys but in a stable order.
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  const esc = (val: unknown) => {
    if (val === null || val === undefined) return '';
    const s = typeof val === 'object' ? JSON.stringify(val) : String(val);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [keys.join(',')];
  for (const r of rows) lines.push(keys.map(k => esc(r[k])).join(','));
  return lines.join('\n') + '\n';
}
