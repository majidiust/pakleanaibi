'use client';
import { useCallback, useEffect, useState } from 'react';
import { DataTable } from '@/components/DataTable';
import { ChartView, type ChartDisplay } from '@/components/ChartView';

interface Display { kind: 'table' | 'bar' | 'line' | 'pie' | 'area'; xField?: string; yField?: string; seriesField?: string; title?: string }
interface CacheInfo { matchType: 'exact' | 'semantic'; similarity?: number; cachedAt: string }
interface Attempt {
  n: number;
  source: 'cache' | 'llm' | 'repair';
  collection: string;
  pipeline: Record<string, unknown>[];
  display: Display;
  explanation: string;
  warnings: string[];
  ok: boolean;
  error?: string;
  rows?: Record<string, unknown>[];
  took?: number;
  count?: number;
  truncated?: boolean;
  cache?: CacheInfo | null;
}
interface RunResponse { final: 'ok' | 'failed'; attempts: Attempt[] }
interface RefineResponse extends Omit<Attempt, 'n' | 'source' | 'ok'> { error?: string; message?: string }
interface Favorite { id: string; question: string; label?: string; hits: number }

const EXAMPLES = [
  'Top 10 users by number of orders in the last 30 days',
  'Monthly revenue from payments for the past 6 months as a line chart',
  'How many orders are in each status? Pie chart please.',
  'Average order value per day for the last 14 days',
];

function SourceBadge({ source }: { source: Attempt['source'] }) {
  const map = {
    cache:  { label: 'cache',  cls: 'pill-ok' },
    llm:    { label: 'model',  cls: 'pill-accent' },
    repair: { label: 'repair', cls: 'pill-warn' },
  } as const;
  const v = map[source];
  return <span className={v.cls}>{v.label}</span>;
}

function AttemptCard({ a, last }: { a: Attempt; last: boolean }) {
  return (
    <div className={`card card-pad space-y-3 ${a.ok ? '' : 'border-err/40'}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="pill">step {a.n}</span>
          <SourceBadge source={a.source} />
          {a.cache && (
            <span className="pill-ok">cache · {a.cache.matchType}
              {a.cache.similarity !== undefined && ` · ${(a.cache.similarity * 100).toFixed(1)}%`}
            </span>
          )}
          {a.ok ? <span className="pill-ok">success</span> : <span className="pill-err">failed</span>}
          <span className="pill"><span className="text-muted mr-1">collection</span>
            <span className="font-mono text-ink">{a.collection}</span>
          </span>
          {a.took !== undefined && <span className="pill num">{a.took} ms · {a.count} rows{a.truncated ? ' · truncated' : ''}</span>}
        </div>
      </div>
      <div>
        <div className="label mb-1">Plan</div>
        <p dir="auto" className="text-sm text-ink-2 whitespace-pre-wrap leading-relaxed">{a.explanation}</p>
      </div>
      {!a.ok && a.error && (
        <div className="surface p-3">
          <div className="label mb-1 text-err">MongoDB error</div>
          <pre className="text-xs text-err whitespace-pre-wrap font-mono">{a.error}</pre>
        </div>
      )}
      {a.warnings.length > 0 && (
        <div className="text-warn text-xs space-y-1">
          {a.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-muted hover:text-ink-2">View pipeline JSON</summary>
        <pre className="text-2xs bg-bg/60 p-3 rounded-md mt-2 overflow-x-auto font-mono text-ink-2">
{JSON.stringify(a.pipeline, null, 2)}
        </pre>
      </details>
      {last && a.ok && a.rows && a.rows.length > 0 && (
        <div className="space-y-3 pt-1">
          {a.display.kind !== 'table' && (
            <ChartView rows={a.rows} display={a.display as ChartDisplay} />
          )}
          <DataTable rows={a.rows} />
        </div>
      )}
      {last && a.ok && a.rows && a.rows.length === 0 && (
        <div className="surface p-4 text-sm text-muted">Query returned no rows.</div>
      )}
    </div>
  );
}

export function ReportsClient() {
  const [question, setQuestion] = useState('');
  const [run, setRun] = useState<RunResponse | null>(null);
  const [busy, setBusy] = useState<'run' | 'refine' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [skipCache, setSkipCache] = useState(false);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [refinement, setRefinement] = useState('');
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [savingFav, setSavingFav] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const loadFavorites = useCallback(async () => {
    const r = await fetch('/api/reports/favorites');
    if (r.ok) setFavorites((await r.json()).favorites);
  }, []);
  useEffect(() => { void loadFavorites(); }, [loadFavorites]);

  async function saveFavorite() {
    const q = question.trim();
    if (!q) return;
    setSavingFav(true);
    try {
      const label = prompt('Label for this prompt (optional):', '') ?? undefined;
      const r = await fetch('/api/reports/favorites', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, label: label || undefined }),
      });
      if (r.ok) void loadFavorites();
    } finally { setSavingFav(false); }
  }
  async function deleteFavorite(id: string) {
    if (!confirm('Remove this saved prompt?')) return;
    const r = await fetch('/api/reports/favorites/' + id, { method: 'DELETE' });
    if (r.ok) void loadFavorites();
  }
  async function useFavorite(f: Favorite) {
    setQuestion(f.question);
    void fetch('/api/reports/favorites/' + f.id, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ used: true }),
    });
  }

  async function onRun() {
    setErr(null); setRun(null); setBusy('run'); setRefinement('');
    try {
      const r = await fetch('/api/reports/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, skipCache, maxAttempts }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.message ?? j.error ?? 'request failed'); return; }
      setRun(j as RunResponse);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed');
    } finally { setBusy(null); }
  }

  async function onRefine() {
    if (!run || run.attempts.length === 0 || !refinement.trim()) return;
    const last = run.attempts[run.attempts.length - 1];
    setBusy('refine'); setErr(null);
    try {
      const r = await fetch('/api/reports/refine', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          question,
          refinement: refinement.trim(),
          previous: {
            collection: last.collection, pipeline: last.pipeline,
            display: last.display, explanation: last.explanation,
            warnings: last.warnings,
          },
          execute: true,
        }),
      });
      const j = (await r.json()) as RefineResponse;
      if (!r.ok && r.status !== 200) { setErr(j.message ?? j.error ?? 'refine failed'); return; }
      const ok = !j.error;
      const newAttempt: Attempt = {
        n: run.attempts.length + 1, source: 'repair',
        collection: j.collection!, pipeline: j.pipeline!,
        display: j.display!, explanation: j.explanation!,
        warnings: j.warnings ?? [],
        ok, error: ok ? undefined : (j.message ?? j.error),
        rows: j.rows, took: j.took, count: j.count, truncated: j.truncated,
        cache: null,
      };
      setRun({ final: ok ? 'ok' : 'failed', attempts: [...run.attempts, newAttempt] });
      setRefinement('');
    } finally { setBusy(null); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tighter2">Reports</h1>
        <p className="text-sm text-muted mt-1">
          Ask in any language. The agent generates a read-only MongoDB pipeline, runs it, and auto-repairs on errors.
        </p>
      </div>

      <div className="card card-pad space-y-3">
        <textarea
          className="input min-h-[96px] text-[15px]"
          dir="auto"
          placeholder="e.g. Top 10 paying users this month… / ۱۰ کاربر برتر از نظر تعداد سفارش در ۳۰ روز اخیر"
          value={question}
          onChange={e => setQuestion(e.target.value)}
        />

        {favorites.length > 0 && (
          <div>
            <div className="label mb-1">Saved prompts</div>
            <div className="flex flex-wrap gap-2">
              {favorites.map(f => (
                <div key={f.id} className="pill hover:bg-panel inline-flex items-center gap-1 pr-1">
                  <button dir="auto" className="text-left" onClick={() => useFavorite(f)} title={f.question}>
                    {f.label || (f.question.length > 60 ? f.question.slice(0, 60) + '…' : f.question)}
                  </button>
                  <button className="text-muted hover:text-err px-1" onClick={() => deleteFavorite(f.id)} title="Remove">×</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <div className="label mb-1">Examples</div>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map(s => (
              <button key={s} className="pill hover:bg-panel" onClick={() => setQuestion(s)}>{s}</button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 flex-wrap pt-1">
          <button className="text-2xs uppercase tracking-[0.08em] text-muted hover:text-ink-2"
            onClick={() => setShowAdvanced(v => !v)}>
            {showAdvanced ? '− advanced' : '+ advanced'}
          </button>
          <div className="flex items-center gap-2">
            <button className="btn-ghost btn-sm" disabled={!question.trim() || savingFav} onClick={saveFavorite}>
              {savingFav ? 'Saving…' : '★ Save prompt'}
            </button>
            <button className="btn-primary" disabled={!question.trim() || busy !== null} onClick={onRun}>
              {busy === 'run' ? 'Running…' : 'Run report'}
            </button>
          </div>
        </div>
        {showAdvanced && (
          <div className="surface p-3 flex flex-wrap items-center gap-4 text-xs">
            <label className="inline-flex items-center gap-2 text-muted">
              <input type="checkbox" checked={skipCache} onChange={e => setSkipCache(e.target.checked)} />
              Bypass cache
            </label>
            <label className="inline-flex items-center gap-2 text-muted">
              Max auto-repair attempts
              <input type="number" min={1} max={5} value={maxAttempts}
                onChange={e => setMaxAttempts(Math.max(1, Math.min(5, +e.target.value || 1)))}
                className="input input-sm w-16 num" />
            </label>
          </div>
        )}
      </div>

      {err && <div className="card card-pad text-err text-sm whitespace-pre-wrap">{err}</div>}

      {run && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="h-sect">
              Trajectory <span className="text-muted font-normal">· {run.attempts.length} attempt{run.attempts.length === 1 ? '' : 's'}</span>
            </div>
            {run.final === 'ok'
              ? <span className="pill-ok">final · success</span>
              : <span className="pill-err">final · failed after {run.attempts.length} attempts</span>}
          </div>

          <div className="space-y-3">
            {run.attempts.map((a, i) => (
              <AttemptCard key={i} a={a} last={i === run.attempts.length - 1} />
            ))}
          </div>

          <div className="card card-pad space-y-2">
            <div className="label">Refine</div>
            <p className="text-xs text-muted">
              Push the agent in a different direction — e.g. {'"'}group by month not week{'"'} or
              {' "'}use displayName instead of username{'"'}. The model rewrites the pipeline and runs it.
            </p>
            <textarea
              className="input min-h-[72px]"
              dir="auto"
              placeholder={'e.g. Filter to only completed orders / فقط سفارشات تکمیل‌شده را در نظر بگیر'}
              value={refinement}
              onChange={e => setRefinement(e.target.value)}
            />
            <div className="flex justify-end">
              <button className="btn-primary btn-sm" disabled={!refinement.trim() || busy !== null} onClick={onRefine}>
                {busy === 'refine' ? 'Refining…' : 'Apply refinement'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
