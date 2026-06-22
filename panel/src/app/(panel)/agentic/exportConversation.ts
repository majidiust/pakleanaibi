// Plain-text export for an agentic conversation. Used by the History
// popover (per-row ⤓) and by the toolbar's "Export current" button.
//
// The format is deliberately human-readable, not round-trippable — it's
// meant for sharing a transcript outside the panel (email, ticket, etc.).
// Pipelines are pretty-printed as JSON so they can be replayed in mongosh
// or pasted back into a saved-template editor.

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  kind?: 'question' | 'report' | 'repair';
}

interface LlmReport {
  collection: string;
  pipeline: Record<string, unknown>[];
  display: { kind: string; xField?: string; yField?: string; seriesField?: string; title?: string };
  explanation: string;
  warnings?: string[];
}

export interface ExportableConversation {
  id: string;
  title?: string;
  history?: ChatMsg[];
  lastReport?: LlmReport | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
}

export interface ExportUser {
  name?: string | null;
  email?: string | null;
}

// Filename slug for the logged-in user. Prefers the email local-part (most
// likely to be unique and short) and strips anything that isn't safe across
// macOS / Windows / Linux file systems.
function userSlug(user: ExportUser): string {
  const raw = (user.email?.split('@')[0] ?? user.name ?? '').trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'user';
}

// Local-time timestamp formatted as YYYY-MM-DD_HH-MM-SS. Local rather than
// UTC because the user thinks of "when did I export this" in their own
// timezone; the file content still records the absolute ISO timestamp.
function fileTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return [
    d.getFullYear(), '-', p(d.getMonth() + 1), '-', p(d.getDate()),
    '_',
    p(d.getHours()), '-', p(d.getMinutes()), '-', p(d.getSeconds()),
  ].join('');
}

export function buildExportFilename(user: ExportUser, when: Date = new Date()): string {
  return `${fileTimestamp(when)}_${userSlug(user)}.txt`;
}

function roleLabel(m: ChatMsg): string {
  if (m.role === 'user') return 'USER';
  const tag = m.kind ? ` (${m.kind})` : '';
  return `ASSISTANT${tag}`;
}

function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  return Number.isFinite(d.getTime()) ? d.toISOString() : '—';
}

export function formatConversationAsText(conv: ExportableConversation, user: ExportUser): string {
  const lines: string[] = [];
  const exportedAt = new Date();
  lines.push('================================================================');
  lines.push(`  Agentic Conversation Export`);
  lines.push('================================================================');
  lines.push(`Title          : ${conv.title || 'Untitled'}`);
  lines.push(`Conversation ID: ${conv.id}`);
  lines.push(`Created at     : ${fmtDate(conv.createdAt)}`);
  lines.push(`Updated at     : ${fmtDate(conv.updatedAt)}`);
  lines.push(`Exported by    : ${(user.name ?? '').trim() || '—'} <${(user.email ?? '').trim() || '—'}>`);
  lines.push(`Exported at    : ${exportedAt.toISOString()}`);
  lines.push(`Messages       : ${conv.history?.length ?? 0}`);
  lines.push('');
  lines.push('----------------------------------------------------------------');
  lines.push('  Conversation');
  lines.push('----------------------------------------------------------------');
  const history = conv.history ?? [];
  if (history.length === 0) {
    lines.push('(empty)');
  } else {
    history.forEach((m, i) => {
      lines.push('');
      lines.push(`[${i + 1}] ${roleLabel(m)}`);
      lines.push(m.content ?? '');
    });
  }
  if (conv.lastReport) {
    const r = conv.lastReport;
    lines.push('');
    lines.push('----------------------------------------------------------------');
    lines.push('  Last Report');
    lines.push('----------------------------------------------------------------');
    lines.push(`Collection : ${r.collection}`);
    lines.push(`Display    : ${r.display?.kind ?? '—'}`
      + (r.display?.xField ? ` xField=${r.display.xField}` : '')
      + (r.display?.yField ? ` yField=${r.display.yField}` : '')
      + (r.display?.seriesField ? ` seriesField=${r.display.seriesField}` : '')
      + (r.display?.title ? ` title="${r.display.title}"` : ''));
    if (r.explanation) {
      lines.push('');
      lines.push('Explanation:');
      lines.push(r.explanation);
    }
    if (r.warnings && r.warnings.length > 0) {
      lines.push('');
      lines.push('Warnings:');
      r.warnings.forEach(w => lines.push(`  - ${w}`));
    }
    lines.push('');
    lines.push('Pipeline:');
    lines.push(JSON.stringify(r.pipeline ?? [], null, 2));
  }
  lines.push('');
  return lines.join('\n');
}

// Trigger the browser to save the given text as a file. Uses the standard
// Blob + temporary anchor pattern so there's no dependency to pull in.
export function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Free the blob URL on the next tick — Firefox needs the URL alive at
  // click time, so we can't revoke synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportConversation(conv: ExportableConversation, user: ExportUser): void {
  const text = formatConversationAsText(conv, user);
  downloadTextFile(buildExportFilename(user), text);
}
