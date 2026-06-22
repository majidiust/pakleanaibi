'use client';
import { useState } from 'react';
import type { Role } from '@/lib/auth';
import type { TemplateDetail } from './types';
import { DataTable } from '@/components/DataTable';
import { ChartView, type ChartDisplay } from '@/components/ChartView';
import { ParamForm } from './ParamForm';
import { DriftBanner } from './DriftBanner';
import { VersionsList } from './VersionsList';
import { EditTemplateModal } from './EditTemplateModal';

interface RunResult {
  rows: Record<string, unknown>[];
  count: number;
  took: number;
  truncated?: boolean;
}

export function TemplateDetailPanel({
  detail, loading, currentUserId, role, onAction, onChanged,
}: {
  detail: TemplateDetail | null;
  loading: boolean;
  currentUserId: string;
  role: Role;
  onAction: (action: 'duplicate' | 'delete', id: string) => void;
  onChanged: () => void;
}) {
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [showQuery, setShowQuery] = useState(false);
  const [editing, setEditing] = useState(false);

  if (!detail) {
    return (
      <div className="card card-pad min-h-[420px] grid place-items-center text-center">
        <div className="max-w-sm space-y-1">
          <div className="text-sm text-muted">{loading ? 'Loading…' : 'Select a template'}</div>
          <div className="text-xs text-muted-2">
            Pick a saved report on the left to view its parameters, version history, and last run status.
          </div>
        </div>
      </div>
    );
  }

  const { template, drift } = detail;
  const canEdit = template.createdBy === currentUserId || role === 'admin';
  const canDelete = canEdit;

  async function onRun(ignoreDrift = false) {
    setRunning(true); setRunErr(null);
    try {
      const r = await fetch(`/api/reports/templates/${template.id}/run`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parameters: paramValues, ignoreDrift }),
      });
      const j = await r.json();
      if (!r.ok) {
        if (j.error === 'drift_detected') {
          setRunErr(`${j.message} Click "Run anyway" to proceed.`);
        } else {
          setRunErr(j.message ?? j.error ?? 'execution failed');
        }
        setResult(null); return;
      }
      setResult({ rows: j.rows, count: j.count, took: j.took, truncated: j.truncated });
      onChanged();
    } catch (e) {
      setRunErr(e instanceof Error ? e.message : 'execution failed');
    } finally { setRunning(false); }
  }

  function exportJson() {
    const data = JSON.stringify({
      title: template.title, description: template.description,
      collection: template.collection, pipeline: template.pipeline,
      parameters: template.parameters, display: template.display,
      version: template.version, exportedAt: new Date().toISOString(),
    }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${template.title.replace(/[^\w-]+/g, '_')}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <div className="card card-pad space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-lg font-semibold tracking-tightish text-ink truncate">{template.title}</div>
            {template.description && (
              <div className="text-sm text-muted mt-1">{template.description}</div>
            )}
            <div className="flex items-center gap-1.5 mt-2 flex-wrap">
              <span className="pill"><span className="text-muted mr-1">collection</span>
                <span className="font-mono text-ink-2">{template.collection}</span></span>
              <span className="pill num">v{template.version}</span>
              <span className="pill num">{template.runCount} run{template.runCount === 1 ? '' : 's'}</span>
              {template.category && <span className="pill">{template.category}</span>}
              {(template.tags ?? []).map(tag => (
                <span key={tag} className="pill text-muted-2">#{tag}</span>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {canEdit && <button className="btn-ghost btn-sm" onClick={() => setEditing(true)}>Edit</button>}
            <button className="btn-ghost btn-sm" onClick={() => onAction('duplicate', template.id)}>Duplicate</button>
            <button className="btn-ghost btn-sm" onClick={() => setShowQuery(s => !s)}>
              {showQuery ? 'Hide query' : 'View query'}
            </button>
            <button className="btn-ghost btn-sm" onClick={exportJson}>Export</button>
            {canDelete && (
              <button className="btn-danger btn-sm" onClick={() => onAction('delete', template.id)}>Delete</button>
            )}
          </div>
        </div>

        <DriftBanner missing={drift.missing} />

        <ParamForm
          parameters={template.parameters}
          values={paramValues}
          onChange={setParamValues}
          onRun={() => onRun(false)}
          onRunIgnoreDrift={drift.missing.length > 0 ? () => onRun(true) : undefined}
          running={running}
        />

        {runErr && <div className="surface p-3 text-sm text-err whitespace-pre-wrap">{runErr}</div>}

        {showQuery && (
          <details open className="surface p-3">
            <summary className="cursor-pointer text-xs text-muted hover:text-ink-2">Pipeline JSON</summary>
            <pre className="text-2xs font-mono text-ink-2 mt-2 overflow-x-auto">
{JSON.stringify(template.pipeline, null, 2)}
            </pre>
          </details>
        )}
      </div>

      {result && (
        <div className="card card-pad space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="pill-ok num">{result.took} ms · {result.count} rows{result.truncated ? ' · truncated' : ''}</span>
            <span className="pill">display · {template.display.kind}</span>
          </div>
          {template.display.kind !== 'table' && result.rows.length > 0 && (
            <ChartView rows={result.rows} display={template.display as ChartDisplay} />
          )}
          {result.rows.length > 0 ? <DataTable rows={result.rows} title={template.title} />
            : <div className="surface p-4 text-sm text-muted">Query returned no rows.</div>}
        </div>
      )}

      <VersionsList templateId={template.id} />

      {editing && (
        <EditTemplateModal
          template={template}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); onChanged(); }}
        />
      )}
    </div>
  );
}
