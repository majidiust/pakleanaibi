'use client';
import { useState } from 'react';
import type { TemplateFull, TemplateVisibility } from './types';

export function EditTemplateModal({
  template, onClose, onSaved,
}: {
  template: TemplateFull;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(template.title);
  const [description, setDescription] = useState(template.description ?? '');
  const [category, setCategory] = useState(template.category ?? '');
  const [tagsInput, setTagsInput] = useState((template.tags ?? []).join(', '));
  const [visibility, setVisibility] = useState<TemplateVisibility>(template.visibility);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
      const r = await fetch(`/api/reports/templates/${template.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          category: category.trim(),
          tags, visibility,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error ?? 'save_failed'); return; }
      onSaved();
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg/70 backdrop-blur-sm grid place-items-center p-4"
         onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card card-pad w-full max-w-lg space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold tracking-tightish">Edit template</div>
            <div className="text-xs text-muted mt-0.5">
              Metadata only. To change the pipeline or parameters, duplicate the template and re-author from the agentic console.
            </div>
          </div>
          <button className="btn-subtle btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="space-y-2">
          <label className="label">Title</label>
          <input className="input" value={title} onChange={e => setTitle(e.target.value)} maxLength={120} />
        </div>
        <div className="space-y-2">
          <label className="label">Description</label>
          <textarea className="input min-h-[72px]" value={description}
            onChange={e => setDescription(e.target.value)} maxLength={2000} />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-2">
            <label className="label">Category</label>
            <input className="input" value={category} onChange={e => setCategory(e.target.value)} maxLength={80} placeholder="e.g. Finance, Sales" />
          </div>
          <div className="space-y-2">
            <label className="label">Visibility</label>
            <select className="input" value={visibility}
              onChange={e => setVisibility(e.target.value as TemplateVisibility)}>
              <option value="private">Private (only you)</option>
              <option value="shared">Shared (visible to all users)</option>
              <option value="public">Public</option>
            </select>
          </div>
        </div>
        <div className="space-y-2">
          <label className="label">Tags <span className="text-muted-2 normal-case tracking-normal">(comma separated)</span></label>
          <input className="input" value={tagsInput} onChange={e => setTagsInput(e.target.value)} placeholder="monthly, ops, kpi" />
        </div>

        {err && <div className="text-xs text-err">{err}</div>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button className="btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={save} disabled={busy || !title.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
