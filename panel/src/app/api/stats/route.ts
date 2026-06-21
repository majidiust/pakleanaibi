import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth';
import { biDb, dataDb } from '@/lib/mongo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try { await requireUser(); } catch (r) { return r as Response; }
  const [data, bi] = await Promise.all([dataDb(), biDb()]);
  const colls = (await data.listCollections({}, { nameOnly: true }).toArray())
    .map(c => c.name)
    .filter(n => !n.startsWith('system.') && !n.startsWith('_sync_state'));

  const top = await Promise.all(
    colls.map(async (name) => ({
      name,
      count: await data.collection(name).estimatedDocumentCount(),
    })),
  );
  top.sort((a, b) => b.count - a.count);

  const syncState = await data.collection('_sync_state').find({}).toArray().catch(() => []);
  const lastSync = syncState
    .map(s => s.updatedAt)
    .filter(Boolean)
    .sort((a: Date, b: Date) => b.getTime() - a.getTime())[0] ?? null;

  const [usersCount, reportsCount] = await Promise.all([
    bi.collection('users').estimatedDocumentCount(),
    bi.collection('reports').estimatedDocumentCount(),
  ]);

  return NextResponse.json({
    database: data.databaseName,
    collectionCount: top.length,
    totalDocs: top.reduce((a, b) => a + b.count, 0),
    topCollections: top.slice(0, 8),
    lastSync,
    bi: { users: usersCount, reports: reportsCount },
  });
}
