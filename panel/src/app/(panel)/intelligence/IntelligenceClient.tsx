'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IntelTabs, PageHeader } from './_ui';

interface Job {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt?: string;
  progress: number;
  step: string;
  perCollection: { name: string; state: string; error?: string }[];
  stats?: { collections: number; fields: number; suggested: number; autoBoosted: number };
  error?: string;
}

interface Summary { collections: number; relationships: number; suggested: number; approved: number; manual: number }

export function IntelligenceClient({ role }: { role: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadSummary = useCallback(async () => {
    const [c, r] = await Promise.all([
      fetch('/api/intel/collections').then(x => x.ok ? x.json() : { collections: [] }),
      fetch('/api/intel/relationships?status=&minConfidence=0&maxConfidence=100').then(x => x.ok ? x.json() : { relationships: [] }),
    ]);
    const rels = r.relationships as { status: string }[];
    setSummary({
      collections: c.collections.length,
      relationships: rels.length,
      suggested: rels.filter(x => x.status === 'suggested').length,
      approved: rels.filter(x => x.status === 'approved').length,
      manual: rels.filter(x => x.status === 'manual').length,
    });
  }, []);

  const loadJob = useCallback(async () => {
    const r = await fetch('/api/intel/analyze');
    if (!r.ok) return;
    const j = await r.json();
    setJob(j.job);
    if (j.job && (j.job.status === 'done' || j.job.status === 'error' || j.job.status === 'cancelled')) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      void loadSummary();
    }
  }, [loadSummary]);

  useEffect(() => { void loadJob(); void loadSummary(); }, [loadJob, loadSummary]);

  useEffect(() => {
    if (job?.status === 'running' || job?.status === 'pending') {
      if (!pollRef.current) pollRef.current = setInterval(loadJob, 1500);
    }
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [job?.status, loadJob]);

  async function analyze() {
    setErr(null);
    const r = await fetch('/api/intel/analyze', { method: 'POST' });
    if (!r.ok) { setErr((await r.json()).error ?? 'failed'); return; }
    void loadJob();
  }

  const running = job?.status === 'running' || job?.status === 'pending';
  const done = job?.perCollection.filter(p => p.state === 'done').length ?? 0;
  const errored = job?.perCollection.filter(p => p.state === 'error').length ?? 0;

  return (
    <div>
      <PageHeader
        title="Database Intelligence"
        subtitle="Self-learning schema discovery and relationship knowledge graph."
        actions={role === 'admin' && (
          <button className="btn-primary" disabled={running} onClick={analyze}>
            {running ? 'Analysing…' : 'Analyse database'}
          </button>
        )}
      />
      <IntelTabs />
      {err && <div className="card card-pad text-err text-sm mb-4">{err}</div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Stat label="Collections" value={summary?.collections ?? '—'} hint="Discovered in metadata" />
        <Stat label="Relationships" value={summary?.relationships ?? '—'} hint={`${summary?.approved ?? 0} approved, ${summary?.manual ?? 0} manual`} />
        <Stat label="Pending review" value={summary?.suggested ?? '—'} hint="Suggestions awaiting approval" />
        <Stat label="Last analysis" value={job?.finishedAt ? new Date(job.finishedAt).toLocaleString() : (job ? job.step : '—')} />
      </div>

      {job && (
        <div className="card mb-4">
          <div className="px-5 py-3 border-b border-line flex items-center justify-between">
            <div>
              <div className="font-medium">Latest analysis</div>
              <div className="text-xs text-muted">
                Started {new Date(job.startedAt).toLocaleString()} · {job.status}
              </div>
            </div>
            <div className="text-xs text-muted">{done} done · {errored} errored · {job.perCollection.length} total</div>
          </div>
          <div className="px-5 py-3">
            <div className="text-xs text-muted mb-1">{job.step} · {job.progress}%</div>
            <div className="h-2 bg-panel2 rounded overflow-hidden">
              <div className="h-full bg-accent transition-all" style={{ width: `${job.progress}%` }} />
            </div>
            {job.error && <div className="text-err text-xs mt-2">{job.error}</div>}
            {job.stats && (
              <div className="mt-3 text-xs text-muted">
                Indexed {job.stats.collections} collections, {job.stats.fields} fields ·
                {' '}{job.stats.suggested} new suggestions · {job.stats.autoBoosted} boosted
              </div>
            )}
          </div>
          <div className="border-t border-line px-5 py-3 max-h-64 overflow-y-auto">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1 text-xs font-mono">
              {job.perCollection.map(p => (
                <div key={p.name} className="flex items-center gap-2 truncate">
                  <Dot state={p.state} />
                  <span className={p.state === 'error' ? 'text-err' : 'text-muted'} title={p.error}>{p.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {role === 'admin' && <ExportImport onImported={loadSummary} />}

      <div className="grid md:grid-cols-2 gap-4">
        <a href="/intelligence/collections" className="card card-pad hover:bg-panel2/40">
          <div className="font-medium">Collections</div>
          <div className="text-sm text-muted mt-1">Browse the inferred schema. Each collection has fields, types, indexes, samples and relationships.</div>
        </a>
        <a href="/intelligence/relationships" className="card card-pad hover:bg-panel2/40">
          <div className="font-medium">Relationships</div>
          <div className="text-sm text-muted mt-1">Review suggested relationships, approve or reject, or create manual ones.</div>
        </a>
        <a href="/intelligence/graph" className="card card-pad hover:bg-panel2/40">
          <div className="font-medium">Graph</div>
          <div className="text-sm text-muted mt-1">Visual knowledge graph of collections and their relationships.</div>
        </a>
        <a href="/intelligence/versions" className="card card-pad hover:bg-panel2/40">
          <div className="font-medium">Versions</div>
          <div className="text-sm text-muted mt-1">Schema history with field-level diff between any two snapshots.</div>
        </a>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="card card-pad">
      <div className="label">{label}</div>
      <div className="text-2xl font-semibold mt-1 tabular-nums truncate">{String(value)}</div>
      {hint && <div className="text-xs text-muted mt-1 truncate">{hint}</div>}
    </div>
  );
}

function Dot({ state }: { state: string }) {
  const color = state === 'done' ? '#22c55e' : state === 'error' ? '#ef4444' : state === 'sampling' ? '#5b8def' : '#475569';
  return <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />;
}


function ExportImport({ onImported }: { onImported: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function importFile(file: File) {
    setBusy(true); setMsg(null);
    try {
      const text = await file.text();
      const body = JSON.parse(text);
      const r = await fetch('/api/intel/import', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'failed');
      setMsg(`Imported ${j.collUpdated} collections, ${j.relAdded} new, ${j.relUpdated} updated relationships.`);
      onImported();
    } catch (e) {
      setMsg('Import failed: ' + (e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="card card-pad mb-4 flex flex-wrap items-center gap-2">
      <div className="font-medium mr-2">Export / Import</div>
      <a className="btn-ghost text-sm" href="/api/intel/export?format=json">Export JSON</a>
      <a className="btn-ghost text-sm" href="/api/intel/export?format=yaml">Export YAML</a>
      <a className="btn-ghost text-sm" href="/api/intel/export?format=csv&what=relationships">Export CSV (rels)</a>
      <label className="btn-ghost text-sm cursor-pointer">
        {busy ? 'Importing…' : 'Import JSON…'}
        <input type="file" accept="application/json,.json" className="hidden" disabled={busy}
               onChange={e => { const f = e.target.files?.[0]; if (f) void importFile(f); e.currentTarget.value = ''; }} />
      </label>
      {msg && <span className="text-xs text-muted ml-2">{msg}</span>}
    </div>
  );
}
