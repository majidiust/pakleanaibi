import { biDb, dataDb } from '@/lib/mongo';
import { getUsageSummary, type UsageSummary } from '@/lib/llm-cost';

export const dynamic = 'force-dynamic';

interface Stats {
  database: string;
  collectionCount: number;
  totalDocs: number;
  topCollections: { name: string; count: number }[];
  lastSync: Date | null;
  bi: { users: number; reports: number };
}

async function loadStats(): Promise<Stats> {
  const [data, bi] = await Promise.all([dataDb(), biDb()]);
  const colls = (await data.listCollections({}, { nameOnly: true }).toArray())
    .map(c => c.name)
    .filter(n => !n.startsWith('system.') && !n.startsWith('_sync_state'));
  const top = await Promise.all(
    colls.map(async name => ({ name, count: await data.collection(name).estimatedDocumentCount() })),
  );
  top.sort((a, b) => b.count - a.count);
  const syncState = await data.collection('_sync_state').find({}).toArray().catch(() => []);
  const lastSync = syncState
    .map(s => s.updatedAt as Date | undefined)
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const [users, reports] = await Promise.all([
    bi.collection('users').estimatedDocumentCount(),
    bi.collection('reports').estimatedDocumentCount(),
  ]);
  return {
    database: data.databaseName,
    collectionCount: top.length,
    totalDocs: top.reduce((a, b) => a + b.count, 0),
    topCollections: top.slice(0, 8),
    lastSync,
    bi: { users, reports },
  };
}

function StatCard({ label, value, hint, accent }: {
  label: string; value: string; hint?: string; accent?: boolean;
}) {
  return (
    <div className="card card-pad relative overflow-hidden">
      {accent && (
        <div aria-hidden className="pointer-events-none absolute -top-12 -right-12 size-32 rounded-full
          bg-gradient-to-br from-accent/20 to-accent2/0 blur-2xl" />
      )}
      <div className="label">{label}</div>
      <div className="text-[1.75rem] leading-tight font-semibold mt-2 tabular-nums tracking-tighter2 text-ink">
        {value}
      </div>
      {hint && <div className="text-xs text-muted mt-1.5">{hint}</div>}
    </div>
  );
}

function fmt(n: number) { return n.toLocaleString('en-US'); }
// Currency formatter tuned for very small per-call costs (typical
// gpt-4o-mini turn lands around $0.0003). Show 4 decimals under $1 so a busy
// day is still legible, fall back to 2 above that for monthly / all-time.
function usd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  if (n === 0) return '$0.00';
  if (n < 1) return `$${n.toFixed(4)}`;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function compactTokens(n: number): string {
  if (n < 1_000) return n.toString();
  if (n < 1_000_000) return (n / 1_000).toFixed(n < 10_000 ? 1 : 0) + 'k';
  return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + 'M';
}

// Empty-state fallback so a brand-new install with no `llm_usage` collection
// renders the section without throwing.
async function loadUsage(): Promise<UsageSummary> {
  try { return await getUsageSummary(); }
  catch { return { totals: { calls: 0, tokens: 0, costUsd: 0 }, today: { calls: 0, tokens: 0, costUsd: 0 }, month: { calls: 0, tokens: 0, costUsd: 0 }, byOp: [], byModel: [], recent: [] }; }
}

export default async function DashboardPage() {
  const [s, usage] = await Promise.all([loadStats(), loadUsage()]);
  const maxDoc = s.topCollections[0]?.count ?? 1;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tighter2">Dashboard</h1>
        <p className="text-sm text-muted mt-1">Snapshot of the mirrored database and BI metadata.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard accent label="Data database" value={s.database} hint={`${s.collectionCount} collections`} />
        <StatCard label="Total documents" value={fmt(s.totalDocs)} hint="Across data collections" />
        <StatCard label="Panel users" value={fmt(s.bi.users)} hint={`${fmt(s.bi.reports)} saved reports`} />
        <StatCard label="Last sync"
          value={s.lastSync ? s.lastSync.toISOString().slice(0, 19).replace('T', ' ') : '—'} hint="UTC" />
      </div>
      <div className="space-y-3">
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <div>
            <div className="h-sect">AI spend</div>
            <p className="text-xs text-muted mt-0.5">Token usage and estimated USD cost across every LLM call made by the panel.</p>
          </div>
          <div className="text-2xs text-muted uppercase tracking-[0.08em]">Live · pricing in <code className="font-mono">lib/llm-cost.ts</code></div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard accent label="Cost today (UTC)" value={usd(usage.today.costUsd)}
            hint={`${fmt(usage.today.calls)} calls · ${compactTokens(usage.today.tokens)} tokens`} />
          <StatCard label="Cost this month" value={usd(usage.month.costUsd)}
            hint={`${fmt(usage.month.calls)} calls · ${compactTokens(usage.month.tokens)} tokens`} />
          <StatCard label="Cost all-time" value={usd(usage.totals.costUsd)}
            hint={`${fmt(usage.totals.calls)} calls · ${compactTokens(usage.totals.tokens)} tokens`} />
          <StatCard label="Avg cost / call" value={
            usage.totals.calls > 0 ? usd(usage.totals.costUsd / usage.totals.calls) : '—'
          } hint={
            usage.totals.calls > 0
              ? `${compactTokens(Math.round(usage.totals.tokens / usage.totals.calls))} tokens avg`
              : 'no calls recorded yet'
          } />
        </div>
        {(usage.byOp.length > 0 || usage.byModel.length > 0) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card">
              <div className="px-5 py-3.5 border-b border-line flex items-center justify-between">
                <div className="h-sect">By operation</div>
                <div className="text-2xs text-muted uppercase tracking-[0.08em]">Top 8 by cost</div>
              </div>
              <div className="table-wrap rounded-t-none border-0">
                <table className="bi">
                  <thead><tr><th>Operation</th><th className="text-right">Calls</th><th className="text-right">Tokens</th><th className="text-right">Cost</th></tr></thead>
                  <tbody>
                    {usage.byOp.length === 0 && <tr><td colSpan={4} className="text-center text-muted text-xs py-6">No usage recorded yet.</td></tr>}
                    {usage.byOp.map(r => (
                      <tr key={r.op}>
                        <td className="font-mono text-xs text-ink">{r.op}</td>
                        <td className="text-right num text-ink-2">{fmt(r.calls)}</td>
                        <td className="text-right num text-ink-2">{compactTokens(r.tokens)}</td>
                        <td className="text-right num text-ink">{usd(r.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="card">
              <div className="px-5 py-3.5 border-b border-line flex items-center justify-between">
                <div className="h-sect">By model</div>
                <div className="text-2xs text-muted uppercase tracking-[0.08em]">Top 8 by cost</div>
              </div>
              <div className="table-wrap rounded-t-none border-0">
                <table className="bi">
                  <thead><tr><th>Model</th><th className="text-right">Calls</th><th className="text-right">Tokens</th><th className="text-right">Cost</th></tr></thead>
                  <tbody>
                    {usage.byModel.length === 0 && <tr><td colSpan={4} className="text-center text-muted text-xs py-6">No usage recorded yet.</td></tr>}
                    {usage.byModel.map(r => (
                      <tr key={r.model}>
                        <td className="font-mono text-xs text-ink">{r.model}</td>
                        <td className="text-right num text-ink-2">{fmt(r.calls)}</td>
                        <td className="text-right num text-ink-2">{compactTokens(r.tokens)}</td>
                        <td className="text-right num text-ink">{usd(r.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
        {usage.recent.length > 0 && (
          <div className="card">
            <div className="px-5 py-3.5 border-b border-line flex items-center justify-between">
              <div className="h-sect">Recent LLM calls</div>
              <div className="text-2xs text-muted uppercase tracking-[0.08em]">Last 8</div>
            </div>
            <div className="table-wrap rounded-t-none border-0">
              <table className="bi">
                <thead><tr><th>When (UTC)</th><th>Operation</th><th>Model</th><th className="text-right">Tokens</th><th className="text-right">Cost</th></tr></thead>
                <tbody>
                  {usage.recent.map((r, i) => (
                    <tr key={i}>
                      <td className="font-mono text-xs text-muted">{r.ts.toISOString().slice(0, 19).replace('T', ' ')}</td>
                      <td className="font-mono text-xs text-ink">{r.op}</td>
                      <td className="font-mono text-xs text-ink-2">{r.model}</td>
                      <td className="text-right num text-ink-2">{compactTokens(r.totalTokens)}</td>
                      <td className="text-right num text-ink">{usd(r.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      <div className="card">
        <div className="px-5 py-3.5 border-b border-line flex items-center justify-between">
          <div className="h-sect">Largest collections</div>
          <div className="text-2xs text-muted uppercase tracking-[0.08em]">Top 8 by document count</div>
        </div>
        <div className="table-wrap rounded-t-none border-0">
          <table className="bi">
            <thead>
              <tr>
                <th>Collection</th>
                <th className="w-1/2">Distribution</th>
                <th className="text-right">Documents</th>
              </tr>
            </thead>
            <tbody>
              {s.topCollections.map(c => {
                const pct = Math.max(2, Math.round((c.count / maxDoc) * 100));
                return (
                  <tr key={c.name}>
                    <td className="font-mono text-xs text-ink">{c.name}</td>
                    <td>
                      <div className="h-1.5 rounded-full bg-panel2 overflow-hidden">
                        <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent2"
                          style={{ width: `${pct}%` }} />
                      </div>
                    </td>
                    <td className="text-right num text-ink-2">{fmt(c.count)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
