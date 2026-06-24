'use client';
// Modal launched from the agentic ResultPanel when the analyst wants to keep
// the current pipeline as a reusable template. Collects title, description,
// category, tags, visibility, and an optional list of parameter slots that
// can later be filled in from the Saved Reports detail view.
//
// When `origin` is provided (the analyst arrived here via "Customize in
// Agentic" from Saved Reports), the modal offers two save modes:
//   - update: PATCH the source template (auto-bumps version, snapshots prev)
//   - new:    POST as a fresh template (default body prefilled from origin)
import { useState } from 'react';
import type { TemplateOrigin } from './AgenticClient';

interface ReportShape {
  collection: string;
  pipeline: Record<string, unknown>[];
  display: { kind: 'table' | 'bar' | 'line' | 'pie' | 'area'; xField?: string; yField?: string; seriesField?: string; title?: string };
  explanation?: string;
}

type Visibility = 'private' | 'shared' | 'public';
type ParamType = 'string' | 'number' | 'date' | 'boolean' | 'objectId';
interface ParamRow { key: string; label: string; type: ParamType; required: boolean }
export type SaveMode = 'update' | 'new';

export function SaveTemplateModal({
  report, sourcePrompt, origin, currentUserId, onClose, onSaved,
}: {
  report: ReportShape;
  sourcePrompt?: string;
  origin?: TemplateOrigin | null;
  currentUserId?: string;
  onClose: () => void;
  onSaved: (id: string, mode: SaveMode) => void;
}) {
  // When customizing an existing template the analyst owns, default to
  // "update" so the common flow is one click. If they don't own it (someone
  // else's shared template) PATCH would be rejected by the server \u2014 fall
  // back to "new" and disable the update radio.
  const canUpdateOrigin = Boolean(origin && origin.createdBy === currentUserId);
  const [mode, setMode] = useState<SaveMode>(canUpdateOrigin ? 'update' : 'new');
  // Prefill metadata fields from the origin so the analyst doesn't have to
  // retype titles/tags when updating. For the "new" mode we suffix the title
  // so the branched template is easy to spot in the list.
  const [title, setTitle] = useState(origin?.title ?? '');
  const [description, setDescription] = useState(origin?.description ?? '');
  const [category, setCategory] = useState(origin?.category ?? '');
  const [tagsInput, setTagsInput] = useState((origin?.tags ?? []).join(', '));
  const [visibility, setVisibility] = useState<Visibility>(origin?.visibility ?? 'private');
  const [params, setParams] = useState<ParamRow[]>(
    (origin?.parameters ?? []).map(p => ({ key: p.key, label: p.label, type: p.type, required: Boolean(p.required) })),
  );
  const [versionNote, setVersionNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Effective title that goes on the wire: in "new" mode if the user hasn't
  // edited the prefilled title we add a "(copy)" suffix so the branch is
  // easy to distinguish from the source in the Saved Reports list.
  function effectiveTitle(): string {
    const t = title.trim();
    if (mode === 'new' && origin && t === (origin.title ?? '').trim()) return `${t} (copy)`;
    return t;
  }

  function addParam() {
    setParams(rows => [...rows, { key: '', label: '', type: 'string', required: false }]);
  }
  function setParam(i: number, patch: Partial<ParamRow>) {
    setParams(rows => rows.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  }
  function removeParam(i: number) {
    setParams(rows => rows.filter((_, idx) => idx !== i));
  }

  async function save() {
    setBusy(true); setErr(null);
    try {
      const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
      // Drop fully-empty parameter rows; validate the rest minimally so the
      // server's zod check doesn't have to do double duty in the UI.
      const cleanedParams = params
        .filter(p => p.key.trim() && p.label.trim())
        .map(p => ({ key: p.key.trim(), label: p.label.trim(), type: p.type, required: p.required }));
      if (mode === 'update' && origin) {
        // PATCH the source template. The server snapshots the previous body
        // to report_template_versions and bumps `version` automatically.
        const r = await fetch(`/api/reports/templates/${origin.id}`, {
          method: 'PATCH', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            title: title.trim() || origin.title,
            description: description.trim(),
            category: category.trim(),
            tags,
            visibility,
            collection: report.collection,
            pipeline: report.pipeline,
            parameters: cleanedParams,
            display: report.display,
            sourcePrompt: sourcePrompt || origin.sourcePrompt,
            versionNote: versionNote.trim() || undefined,
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { setErr(j.error ?? 'update_failed'); return; }
        onSaved(origin.id, 'update');
        return;
      }
      // "new" mode \u2014 POST a fresh template. effectiveTitle() suffixes
      // "(copy)" when branching from an unmodified origin title.
      const r = await fetch('/api/reports/templates', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: effectiveTitle(),
          description: description.trim() || undefined,
          category: category.trim() || undefined,
          tags,
          visibility,
          collection: report.collection,
          pipeline: report.pipeline,
          sourcePrompt: sourcePrompt || origin?.sourcePrompt || undefined,
          parameters: cleanedParams,
          display: report.display,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error ?? 'save_failed'); return; }
      onSaved(j.id as string, 'new');
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg/70 backdrop-blur-sm grid place-items-center p-4"
         onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card card-pad w-full max-w-xl space-y-3 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold tracking-tightish">
              {mode === 'update' && origin ? 'Update Saved Report' : 'Save as Report Template'}
            </div>
            <div className="text-xs text-muted mt-0.5">
              {mode === 'update' && origin ? (
                <>Updating &ldquo;{origin.title}&rdquo; (v{origin.version}). The previous body is kept in version history.</>
              ) : (
                <>Stores the current pipeline ({report.pipeline.length} stage{report.pipeline.length === 1 ? '' : 's'} on
                  <span className="font-mono mx-1 text-ink-2">{report.collection}</span>)
                  as a reusable template under Saved Reports.</>
              )}
            </div>
          </div>
          <button className="btn-subtle btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {origin && (
          <div className="rounded-md border border-line bg-bg-2 p-2.5 space-y-1.5">
            <div className="text-xs text-muted-2 uppercase tracking-wide">Save mode</div>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="radio" name="save-mode" className="mt-0.5"
                     checked={mode === 'update'} disabled={!canUpdateOrigin}
                     onChange={() => setMode('update')} />
              <span className="leading-snug">
                <span className="font-medium">Update original template</span>
                <span className="text-muted block text-xs">
                  {canUpdateOrigin
                    ? `Patch \u201c${origin.title}\u201d in place. Bumps to v${origin.version + 1}; previous body kept as v${origin.version}.`
                    : 'You don\u2019t own this template, so updating it isn\u2019t available. Saving as new will branch a copy you own.'}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="radio" name="save-mode" className="mt-0.5"
                     checked={mode === 'new'} onChange={() => setMode('new')} />
              <span className="leading-snug">
                <span className="font-medium">Save as new template</span>
                <span className="text-muted block text-xs">
                  Creates an independent copy. Useful for branching variations without altering the source.
                </span>
              </span>
            </label>
          </div>
        )}

        <div className="space-y-2">
          <label className="label">Title <span className="text-err">*</span></label>
          <input className="input" value={title} onChange={e => setTitle(e.target.value)}
                 placeholder="e.g. Monthly revenue by product" maxLength={120} autoFocus />
        </div>
        <div className="space-y-2">
          <label className="label">Description</label>
          <textarea className="input min-h-[64px]" value={description}
                    onChange={e => setDescription(e.target.value)} maxLength={2000}
                    placeholder="What this report answers, who uses it, expected refresh cadence." />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="space-y-2">
            <label className="label">Category</label>
            <input className="input" value={category} onChange={e => setCategory(e.target.value)}
                   placeholder="e.g. Finance, Sales, Ops" maxLength={80} />
          </div>
          <div className="space-y-2">
            <label className="label">Visibility</label>
            <select className="input" value={visibility} onChange={e => setVisibility(e.target.value as Visibility)}>
              <option value="private">Private (only you)</option>
              <option value="shared">Shared (all users)</option>
              <option value="public">Public</option>
            </select>
          </div>
        </div>
        <div className="space-y-2">
          <label className="label">Tags <span className="text-muted-2 normal-case tracking-normal">(comma separated)</span></label>
          <input className="input" value={tagsInput} onChange={e => setTagsInput(e.target.value)}
                 placeholder="monthly, ops, kpi" />
        </div>

        <ParamEditor params={params} onAdd={addParam} onSet={setParam} onRemove={removeParam} />

        {mode === 'update' && origin && (
          <div className="space-y-2">
            <label className="label">Version note <span className="text-muted-2 normal-case tracking-normal">(optional)</span></label>
            <input className="input" value={versionNote} onChange={e => setVersionNote(e.target.value)}
                   placeholder="What changed in this version (added filter, swapped chart, etc.)" maxLength={200} />
          </div>
        )}

        {err && <div className="text-xs text-err">{err}</div>}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line mt-2">
          <button className="btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={save} disabled={busy || !title.trim()}>
            {busy ? 'Saving…' : (mode === 'update' && origin ? `Update v${origin.version + 1}` : 'Save template')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ParamEditor({
  params, onAdd, onSet, onRemove,
}: {
  params: ParamRow[];
  onAdd: () => void;
  onSet: (i: number, patch: Partial<ParamRow>) => void;
  onRemove: (i: number) => void;
}) {
  return (
    <details className="surface p-3" open={params.length > 0}>
      <summary className="cursor-pointer text-xs text-muted hover:text-ink-2 flex items-center justify-between">
        <span>Parameters <span className="text-muted-2">(optional)</span></span>
        <span className="text-2xs text-muted-2">replace values in the pipeline with <span className="kbd">{'{{key}}'}</span> or <span className="kbd">{'{"$param":"key"}'}</span></span>
      </summary>
      <div className="mt-3 space-y-2">
        {params.length === 0 && (
          <div className="text-2xs text-muted">
            Define slots like <span className="kbd">startDate</span> or <span className="kbd">status</span> so users can re-run this report with different inputs.
          </div>
        )}
        {params.map((p, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_120px_72px_28px] gap-2 items-center">
            <input className="input input-sm" placeholder="key" value={p.key}
                   onChange={e => onSet(i, { key: e.target.value })} />
            <input className="input input-sm" placeholder="label" value={p.label}
                   onChange={e => onSet(i, { label: e.target.value })} />
            <select className="input input-sm" value={p.type}
                    onChange={e => onSet(i, { type: e.target.value as ParamType })}>
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="date">date</option>
              <option value="boolean">boolean</option>
              <option value="objectId">objectId</option>
            </select>
            <label className="flex items-center gap-1.5 text-2xs text-muted">
              <input type="checkbox" checked={p.required}
                     onChange={e => onSet(i, { required: e.target.checked })} />
              req&apos;d
            </label>
            <button className="btn-subtle btn-sm" onClick={() => onRemove(i)} aria-label="Remove">✕</button>
          </div>
        ))}
        <button className="btn-ghost btn-sm" onClick={onAdd}>+ Add parameter</button>
      </div>
    </details>
  );
}
