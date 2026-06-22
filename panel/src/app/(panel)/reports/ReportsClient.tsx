'use client';
import { useCallback, useEffect, useState } from 'react';
import { DataTable } from '@/components/DataTable';
import { ChartView, type ChartDisplay } from '@/components/ChartView';

interface CacheInfo { matchType: 'exact' | 'semantic'; similarity?: number; cachedAt: string }
interface AskResult {
  collection: string;
  pipeline: Record<string, unknown>[];
  display: { kind: 'table' | 'bar' | 'line' | 'pie' | 'area'; xField?: string; yField?: string; seriesField?: string; title?: string };
  explanation: string;
  warnings: string[];
  cache?: CacheInfo | null;
}
interface ExecResult { rows: Record<string, unknown>[]; took: number; count: number; truncated: boolean }

const EXAMPLES = [
  'Top 10 users by number of orders in the last 30 days',
  'Monthly revenue from payments for the past 6 months as a line chart',
  'How many orders are in each status? Pie chart please.',
  'Average order value per day for the last 14 days',
];

interface Favorite { id: string; question: string; label?: string; hits: number }

export function ReportsClient() {
  const [question, setQuestion] = useState('');
  const [ask, setAsk] = useState<AskResult | null>(null);
  const [exec, setExec] = useState<ExecResult | null>(null);
  const [busy, setBusy] = useState<'ask' | 'run' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [skipCache, setSkipCache] = useState(false);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [savingFav, setSavingFav] = useState(false);

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
    // Bump hit counter so the most-used prompts surface first.
    void fetch('/api/reports/favorites/' + f.id, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ used: true }),
    });
  }

  async function onAsk() {
    setErr(null); setAsk(null); setExec(null); setBusy('ask');
    try {
      const r = await fetch('/api/reports/ask', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, skipCache }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.message ?? j.error ?? 'request failed'); return; }
      setAsk(j);
    } finally { setBusy(null); }
  }

  async function onRun() {
    if (!ask) return;
    setErr(null); setExec(null); setBusy('run');
    try {
      const r = await fetch('/api/reports/execute', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ collection: ask.collection, pipeline: ask.pipeline }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.message ?? j.error ?? 'execution failed'); return; }
      setExec(j);
    } finally { setBusy(null); }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-muted">Ask a question in any language — English, Persian, etc. The model produces a read-only MongoDB pipeline.</p>
      </div>

      <div className="card card-pad space-y-3">
        <textarea
          className="input min-h-[90px]"
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

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <label className="text-xs text-muted inline-flex items-center gap-2">
            <input type="checkbox" checked={skipCache} onChange={e => setSkipCache(e.target.checked)} />
            Bypass cache (force a fresh OpenAI call)
          </label>
          <div className="flex items-center gap-2">
            <button className="btn-ghost text-sm" disabled={!question.trim() || savingFav} onClick={saveFavorite}>
              {savingFav ? 'Saving…' : '★ Save prompt'}
            </button>
            <button className="btn-primary" disabled={!question.trim() || busy !== null} onClick={onAsk}>
              {busy === 'ask' ? 'Thinking…' : 'Generate query'}
            </button>
          </div>
        </div>
      </div>

      {err && <div className="card card-pad text-err text-sm whitespace-pre-wrap">{err}</div>}

      {ask && (
        <div className="card card-pad space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="label">Collection</div>
              <div className="font-mono text-sm">{ask.collection}</div>
              {ask.cache && (
                <div className="mt-1">
                  <span className="pill text-ok border-ok/40">
                    Cache · {ask.cache.matchType}
                    {ask.cache.similarity !== undefined && ` · ${(ask.cache.similarity * 100).toFixed(1)}%`}
                  </span>
                </div>
              )}
            </div>
            <button className="btn-primary" disabled={busy !== null} onClick={onRun}>
              {busy === 'run' ? 'Running…' : 'Run query'}
            </button>
          </div>
          <div>
            <div className="label mb-1">Plan</div>
            <p dir="auto" className="text-sm text-ink whitespace-pre-wrap">{ask.explanation}</p>
          </div>
          {ask.warnings.length > 0 && (
            <div className="text-warn text-xs space-y-1">
              {ask.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-xs text-muted">View pipeline JSON</summary>
            <pre className="text-xs bg-bg/60 p-3 rounded-md mt-2 overflow-x-auto">
{JSON.stringify(ask.pipeline, null, 2)}
            </pre>
          </details>
        </div>
      )}

      {exec && (
        <div className="space-y-4">
          <div className="text-xs text-muted">
            {exec.count} row{exec.count === 1 ? '' : 's'} · {exec.took} ms
            {exec.truncated && ' · truncated to max'}
          </div>
          {ask && ask.display.kind !== 'table' && exec.rows.length > 0 && (
            <ChartView rows={exec.rows} display={ask.display as ChartDisplay} />
          )}
          <div className="card card-pad">
            <DataTable rows={exec.rows} />
          </div>
        </div>
      )}
    </div>
  );
}
