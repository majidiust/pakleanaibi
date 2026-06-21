import { biDb, dataDb } from '@/lib/mongo';

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

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card card-pad">
      <div className="label">{label}</div>
      <div className="text-2xl font-semibold mt-1 tabular-nums">{value}</div>
      {hint && <div className="text-xs text-muted mt-1">{hint}</div>}
    </div>
  );
}

function fmt(n: number) { return n.toLocaleString('en-US'); }

export default async function DashboardPage() {
  const s = await loadStats();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted">Snapshot of the mirrored database and BI metadata.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Data database" value={s.database} hint={`${s.collectionCount} collections`} />
        <StatCard label="Total documents" value={fmt(s.totalDocs)} hint="Across data collections" />
        <StatCard label="Panel users" value={fmt(s.bi.users)} hint={`${fmt(s.bi.reports)} saved reports`} />
        <StatCard label="Last sync" value={s.lastSync ? s.lastSync.toISOString().slice(0, 19).replace('T', ' ') : '—'} hint="UTC" />
      </div>
      <div className="card">
        <div className="px-5 py-3 border-b border-line flex items-center justify-between">
          <div className="font-medium">Largest collections</div>
          <div className="text-xs text-muted">Top 8 by document count</div>
        </div>
        <div className="table-wrap rounded-t-none">
          <table className="bi">
            <thead><tr><th>Collection</th><th className="text-right">Documents</th></tr></thead>
            <tbody>
              {s.topCollections.map(c => (
                <tr key={c.name}>
                  <td className="font-mono">{c.name}</td>
                  <td className="text-right tabular-nums">{fmt(c.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
