import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { intelColl, intelRels } from '@/lib/intel/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim();
  const tag = url.searchParams.get('tag');
  const filter: Record<string, unknown> = {};
  if (q) filter.$or = [
    { name: { $regex: q, $options: 'i' } },
    { description: { $regex: q, $options: 'i' } },
    { entity: { $regex: q, $options: 'i' } },
    { tags: { $regex: q, $options: 'i' } },
  ];
  if (tag) filter.tags = tag;

  const [colls, rels] = await Promise.all([intelColl(), intelRels()]);
  // Omit the heaviest sub-documents on the list endpoint.
  const docs = await colls.find(filter, {
    projection: { samples: 0 },
  }).sort({ docCount: -1 }).toArray();

  // Count relationships per collection so the list page can show "linked to N".
  const incoming = await rels.aggregate<{ _id: string; n: number }>([
    { $match: { status: { $in: ['approved', 'manual'] } } },
    { $group: { _id: '$target.collection', n: { $sum: 1 } } },
  ]).toArray();
  const outgoing = await rels.aggregate<{ _id: string; n: number }>([
    { $match: { status: { $in: ['approved', 'manual'] } } },
    { $group: { _id: '$source.collection', n: { $sum: 1 } } },
  ]).toArray();
  const inMap = new Map(incoming.map(x => [x._id, x.n]));
  const outMap = new Map(outgoing.map(x => [x._id, x.n]));

  return NextResponse.json({
    collections: docs.map(d => ({
      ...d, _id: undefined, id: String(d._id),
      incoming: inMap.get(d.name) ?? 0,
      outgoing: outMap.get(d.name) ?? 0,
    })),
  });
}
