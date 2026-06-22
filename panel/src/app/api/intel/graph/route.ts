import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { intelColl, intelRels } from '@/lib/intel/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try { await requireRole('admin', 'analyst', 'viewer'); } catch (r) { return r as Response; }
  const url = new URL(req.url);
  // status=approved|all  — defaults to approved+manual (only "active" graph).
  const which = url.searchParams.get('status') ?? 'active';
  const filter: Record<string, unknown> = {};
  if (which === 'active') filter.status = { $in: ['approved', 'manual'] };
  else if (which === 'suggested') filter.status = 'suggested';
  // 'all' -> no filter.

  const [colls, rels] = await Promise.all([intelColl(), intelRels()]);
  const [cDocs, rDocs] = await Promise.all([
    colls.find({}, { projection: { samples: 0, fields: { $slice: 1 } } }).toArray(),
    rels.find(filter).toArray(),
  ]);
  const nodes = cDocs.map(c => ({
    id: c.name,
    label: c.label ?? c.name,
    entity: c.entity ?? '',
    description: c.description ?? '',
    tags: c.tags,
    docCount: c.docCount,
    fieldsCount: c.fields?.length ?? 0,
  }));
  const edges = rDocs.map(r => ({
    id: String(r._id),
    source: r.source.collection,
    sourceField: r.source.field,
    target: r.target.collection,
    targetField: r.target.field,
    type: r.type,
    status: r.status,
    confidence: r.confidence,
    color: r.color,
  })).filter(e => e.source !== e.target || true); // include embedded self-loops
  return NextResponse.json({ nodes, edges });
}
