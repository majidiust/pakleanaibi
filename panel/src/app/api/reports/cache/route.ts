import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { biDb } from '@/lib/mongo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireRole('admin'); } catch (r) { return r as Response; }
  const url = new URL(req.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10) || 100, 500);

  const db = await biDb();
  const rows = await db.collection('report_cache')
    .find({}, { projection: { embedding: 0, pipeline: 0 } })
    .sort({ lastUsedAt: -1 })
    .limit(limit)
    .toArray();

  const stats = await db.collection('report_cache').aggregate([
    { $group: {
      _id: null,
      total: { $sum: 1 },
      totalHits: { $sum: '$hits' },
      withEmbedding: { $sum: { $cond: [{ $ifNull: ['$embedding', false] }, 1, 0] } },
    } },
  ]).toArray();

  return NextResponse.json({
    items: rows.map(r => ({ ...r, id: String(r._id), _id: undefined })),
    stats: stats[0] ?? { total: 0, totalHits: 0, withEmbedding: 0 },
  });
}

export async function DELETE() {
  try { await requireRole('admin'); } catch (r) { return r as Response; }
  const db = await biDb();
  const r = await db.collection('report_cache').deleteMany({});
  return NextResponse.json({ deleted: r.deletedCount });
}
