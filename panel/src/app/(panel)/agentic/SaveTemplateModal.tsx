'use client';
// Modal launched from the agentic ResultPanel when the analyst wants to keep
// the current pipeline as a reusable template. Collects title, description,
// category, tags, visibility, and an optional list of parameter slots that
// can later be filled in from the Saved Reports detail view.
import { useState } from 'react';

interface ReportShape {
  collection: string;
  pipeline: Record<string, unknown>[];
  display: { kind: 'table' | 'bar' | 'line' | 'pie' | 'area'; xField?: string; yField?: string; seriesField?: string; title?: string };
  explanation?: string;
}

type Visibility = 'private' | 'shared' | 'public';
type ParamType = 'string' | 'number' | 'date' | 'boolean' | 'objectId';
interface ParamRow { key: string; label: string; type: ParamType; required: boolean }

export function SaveTemplateModal({
  report, sourcePrompt, onClose, onSaved,
}: {
  report: ReportShape;
  sourcePrompt?: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('private');
  const [params, setParams] = useState<ParamRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
      const r = await fetch('/api/reports/templates', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          category: category.trim() || undefined,
          tags,
          visibility,
          collection: report.collection,
          pipeline: report.pipeline,
          sourcePrompt: sourcePrompt || undefined,
          parameters: cleanedParams,
          display: report.display,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error ?? 'save_failed'); return; }
      onSaved(j.id as string);
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg/70 backdrop-blur-sm grid place-items-center p-4"
         onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card card-pad w-full max-w-xl space-y-3 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-lg font-semibold tracking-tightish">Save as Report Template</div>
            <div className="text-xs text-muted mt-0.5">
              Stores the current pipeline ({report.pipeline.length} stage{report.pipeline.length === 1 ? '' : 's'} on
              <span className="font-mono mx-1 text-ink-2">{report.collection}</span>)
              as a reusable template under Saved Reports.
            </div>
          </div>
          <button className="btn-subtle btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

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

        {err && <div className="text-xs text-err">{err}</div>}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-line mt-2">
          <button className="btn-ghost btn-sm" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={save} disabled={busy || !title.trim()}>
            {busy ? 'Saving…' : 'Save template'}
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
