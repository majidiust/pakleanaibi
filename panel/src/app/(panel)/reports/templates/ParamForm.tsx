'use client';
import type { TemplateParameter } from './types';

function defaultDisplayValue(p: TemplateParameter): string {
  if (p.defaultValue === undefined || p.defaultValue === null) return '';
  return String(p.defaultValue);
}

function inputForType(p: TemplateParameter, value: unknown, set: (v: unknown) => void) {
  const raw = value === undefined || value === null ? '' : String(value);
  if (p.options && p.options.length > 0) {
    return (
      <select className="input" value={raw} onChange={e => set(e.target.value)}>
        <option value="">— select —</option>
        {p.options.map(o => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
      </select>
    );
  }
  if (p.type === 'boolean') {
    return (
      <select className="input" value={raw} onChange={e => set(e.target.value === 'true')}>
        <option value="">— select —</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (p.type === 'date') {
    // datetime-local widget; the API coerces ISO strings to BSON Date.
    return <input type="datetime-local" className="input" value={raw} onChange={e => set(e.target.value)} />;
  }
  if (p.type === 'number') {
    return <input type="number" className="input" value={raw} onChange={e => set(e.target.value)} placeholder={defaultDisplayValue(p)} />;
  }
  return <input type="text" className="input" value={raw} onChange={e => set(e.target.value)} placeholder={defaultDisplayValue(p)} />;
}

export function ParamForm({
  parameters, values, onChange, onRun, onRunIgnoreDrift, running,
}: {
  parameters: TemplateParameter[];
  values: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onRun: () => void;
  onRunIgnoreDrift?: () => void;
  running: boolean;
}) {
  if (parameters.length === 0) {
    return (
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-muted">This template has no parameters.</div>
        <div className="flex items-center gap-2">
          {onRunIgnoreDrift && (
            <button className="btn-ghost btn-sm" onClick={onRunIgnoreDrift} disabled={running}>
              {running ? 'Running…' : 'Run anyway'}
            </button>
          )}
          <button className="btn-primary btn-sm" onClick={onRun} disabled={running}>
            {running ? 'Running…' : '▶ Run'}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="label">Parameters</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {parameters.map(p => (
          <div key={p.key} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <label className="text-xs text-ink-2 font-medium">
                {p.label}
                {p.required && <span className="text-err ml-1">*</span>}
              </label>
              <span className="text-2xs text-muted-2 font-mono">{p.type}</span>
            </div>
            {inputForType(p, values[p.key], v => onChange({ ...values, [p.key]: v }))}
            {p.description && <div className="text-2xs text-muted">{p.description}</div>}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2">
        {onRunIgnoreDrift && (
          <button className="btn-ghost btn-sm" onClick={onRunIgnoreDrift} disabled={running}>
            {running ? 'Running…' : 'Run anyway'}
          </button>
        )}
        <button className="btn-primary btn-sm" onClick={onRun} disabled={running}>
          {running ? 'Running…' : '▶ Run'}
        </button>
      </div>
    </div>
  );
}
