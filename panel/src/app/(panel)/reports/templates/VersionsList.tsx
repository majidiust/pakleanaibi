'use client';
import { useEffect, useState } from 'react';
import type { TemplateVersionEntry } from './types';

export function VersionsList({ templateId }: { templateId: string }) {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<TemplateVersionEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || versions) return;
    setLoading(true);
    void fetch(`/api/reports/templates/${templateId}/versions`)
      .then(r => r.json())
      .then(j => setVersions(j.versions ?? []))
      .catch(() => setVersions([]))
      .finally(() => setLoading(false));
  }, [open, versions, templateId]);

  // Reset cached list when the template changes underneath us.
  useEffect(() => { setVersions(null); setOpen(false); }, [templateId]);

  return (
    <div className="card">
      <button
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-panel2/40"
        onClick={() => setOpen(o => !o)}>
        <div className="h-sect">Version history</div>
        <span className="text-2xs text-muted">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="border-t border-line">
          {loading && <div className="p-4 text-xs text-muted">Loading…</div>}
          {!loading && versions && versions.length === 0 && (
            <div className="p-4 text-xs text-muted">
              No prior versions. Each edit that touches the pipeline or parameters
              creates a snapshot here.
            </div>
          )}
          {!loading && versions && versions.length > 0 && (
            <ul className="divide-y divide-line">
              {versions.map(v => (
                <li key={v.id} className="px-4 py-2.5 flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm text-ink">v{v.version}</div>
                    {v.note && <div className="text-xs text-muted mt-0.5">{v.note}</div>}
                  </div>
                  <div className="text-right text-2xs text-muted-2 whitespace-nowrap">
                    <div>{new Date(v.takenAt).toLocaleString()}</div>
                    <div className="font-mono">{v.takenBy.slice(-6)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
