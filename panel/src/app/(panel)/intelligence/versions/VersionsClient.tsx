'use client';
import { useEffect, useMemo, useState } from 'react';
import { IntelTabs, PageHeader } from '../_ui';

interface Version {
  id: string; version: number; takenAt: string; takenBy: string;
  collections: number; relationships: number;
}
interface Diff {
  collections: {
    added: string[]; removed: string[];
    fieldChanges: { name: string; addedFields: string[]; removedFields: string[] }[];
  };
  relationships: {
    added: string[]; removed: string[];
    statusChanges: { fingerprint: string; from: string; to: string }[];
  };
}

export function VersionsClient({ role: _role }: { role: string }) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [diff, setDiff] = useState<Diff | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/intel/versions').then(r => r.json()).then(j => {
      setVersions(j.versions);
      if (j.versions.length >= 2) { setFrom(j.versions[1].version); setTo(j.versions[0].version); }
      else if (j.versions.length === 1) { setFrom(j.versions[0].version); setTo(j.versions[0].version); }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (from == null || to == null) return;
    fetch(`/api/intel/versions?from=${from}&to=${to}`).then(r => r.ok ? r.json() : null).then(j => setDiff(j?.diff ?? null));
  }, [from, to]);

  const hasChanges = useMemo(() => {
    if (!diff) return false;
    return diff.collections.added.length || diff.collections.removed.length || diff.collections.fieldChanges.length
      || diff.relationships.added.length || diff.relationships.removed.length || diff.relationships.statusChanges.length;
  }, [diff]);

  return (
    <div>
      <PageHeader title="Schema versions" subtitle="Every analysis snapshots the inferred schema. Compare any two snapshots field-by-field." />
      <IntelTabs />

      {loading && <div className="card card-pad text-muted">Loading…</div>}
      {!loading && versions.length === 0 && (
        <div className="card card-pad text-muted">No snapshots yet. Run an analysis to create the first version.</div>
      )}

      {versions.length > 0 && (
        <div className="grid lg:grid-cols-[320px_1fr] gap-3">
          <div className="card card-pad">
            <div className="font-medium mb-2">History</div>
            <div className="max-h-[480px] overflow-y-auto -mx-1">
              {versions.map(v => (
                <div key={v.id} className="flex items-center gap-2 px-1 py-1 text-sm">
                  <label className="flex items-center gap-1 text-xs text-muted">
                    <input type="radio" name="from" checked={from === v.version} onChange={() => setFrom(v.version)} /> A
                  </label>
                  <label className="flex items-center gap-1 text-xs text-muted">
                    <input type="radio" name="to" checked={to === v.version} onChange={() => setTo(v.version)} /> B
                  </label>
                  <div className="flex-1 min-w-0">
                    <div className="font-mono">v{v.version}</div>
                    <div className="text-xs text-muted truncate">{new Date(v.takenAt).toLocaleString()} · {v.collections}c · {v.relationships}r</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card card-pad">
            <div className="font-medium mb-2">
              Diff: v{from} <span className="text-muted">→</span> v{to}
            </div>
            {!diff && <div className="text-muted text-sm">Select two versions.</div>}
            {diff && !hasChanges && <div className="text-muted text-sm">No differences between these snapshots.</div>}
            {diff && hasChanges && (
              <div className="space-y-4">
                <DiffSection title="Collections added" items={diff.collections.added} color="ok" />
                <DiffSection title="Collections removed" items={diff.collections.removed} color="err" />
                {diff.collections.fieldChanges.length > 0 && (
                  <div>
                    <div className="label mb-1">Field changes</div>
                    <div className="space-y-2">
                      {diff.collections.fieldChanges.map(c => (
                        <div key={c.name} className="text-xs">
                          <div className="font-mono">{c.name}</div>
                          {c.addedFields.length > 0 && <div className="text-ok ml-3">+ {c.addedFields.join(', ')}</div>}
                          {c.removedFields.length > 0 && <div className="text-err ml-3">− {c.removedFields.join(', ')}</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                <DiffSection title="Relationships added" items={diff.relationships.added} color="ok" mono />
                <DiffSection title="Relationships removed" items={diff.relationships.removed} color="err" mono />
                {diff.relationships.statusChanges.length > 0 && (
                  <div>
                    <div className="label mb-1">Status transitions</div>
                    <div className="space-y-1">
                      {diff.relationships.statusChanges.map(s => (
                        <div key={s.fingerprint} className="text-xs font-mono">
                          {s.fingerprint.slice(0, 10)}… <span className="text-muted">{s.from}</span> → <span>{s.to}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DiffSection({ title, items, color, mono }: { title: string; items: string[]; color: 'ok' | 'err'; mono?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="label mb-1">{title} ({items.length})</div>
      <div className={`flex flex-wrap gap-1 text-xs ${mono ? 'font-mono' : ''}`}>
        {items.map(i => (
          <span key={i} className={`pill ${color === 'ok' ? '!text-ok !border-ok/40' : '!text-err !border-err/40'}`}>{i}</span>
        ))}
      </div>
    </div>
  );
}
