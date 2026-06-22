import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { intelRels, audit } from '@/lib/intel/storage';
import { relFingerprint } from '@/lib/intel';
import { invalidateSchemaCache } from '@/lib/schema';
import type { IntelRelationship } from '@/lib/intel/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REL_TYPES = ['one-to-one','one-to-many','many-to-one','many-to-many','embedded','soft','derived','chain'] as const;
const STATUSES = ['suggested','approved','rejected','manual','archived'] as const;

export async function GET(req: Request) {
  try { await requireRole('admin', 'analyst', 'viewer'); } catch (r) { return r as Response; }
  const url = new URL(req.url);
  const status = url.searchParams.get('status');
  const min = Number(url.searchParams.get('minConfidence') ?? 0);
  const max = Number(url.searchParams.get('maxConfidence') ?? 100);
  const collection = url.searchParams.get('collection');
  const type = url.searchParams.get('type');
  const q = url.searchParams.get('q')?.trim();

  const filter: Record<string, unknown> = { confidence: { $gte: min, $lte: max } };
  if (status && STATUSES.includes(status as typeof STATUSES[number])) filter.status = status;
  if (type && REL_TYPES.includes(type as typeof REL_TYPES[number])) filter.type = type;
  if (collection) filter.$or = [{ 'source.collection': collection }, { 'target.collection': collection }];
  if (q) filter.$or = [
    { 'source.collection': { $regex: q, $options: 'i' } },
    { 'target.collection': { $regex: q, $options: 'i' } },
    { 'source.field': { $regex: q, $options: 'i' } },
    { reason: { $regex: q, $options: 'i' } },
    { tags: { $regex: q, $options: 'i' } },
  ];

  const rels = await intelRels();
  const docs = await rels.find(filter).sort({ status: 1, confidence: -1 }).limit(500).toArray();
  return NextResponse.json({
    relationships: docs.map(d => ({ ...d, _id: undefined, id: String(d._id) })),
  });
}

const Create = z.object({
  source: z.object({ collection: z.string(), field: z.string(), matchOn: z.string().optional() }),
  target: z.object({ collection: z.string(), field: z.string(), matchOn: z.string().optional() }),
  type: z.enum(REL_TYPES),
  cardinality: z.enum(['1:1','1:N','N:1','N:N']).optional(),
  notes: z.string().max(4000).optional(),
  tags: z.array(z.string()).max(20).optional(),
  color: z.string().max(20).optional(),
});

export async function POST(req: Request) {
  let me;
  try { me = await requireRole('admin'); } catch (r) { return r as Response; }
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const now = new Date();
  const fp = relFingerprint({
    source: parsed.data.source, target: parsed.data.target, type: parsed.data.type,
  });
  const doc: IntelRelationship = {
    fingerprint: fp, source: parsed.data.source, target: parsed.data.target,
    type: parsed.data.type, cardinality: parsed.data.cardinality,
    status: 'manual', confidence: -1, detection: 'manual',
    reason: 'Manually created.', signals: [{ label: 'manual', weight: 100 }],
    tags: parsed.data.tags ?? [], notes: parsed.data.notes, color: parsed.data.color,
    createdAt: now, updatedAt: now, createdBy: me.sub,
    approvedBy: me.sub, approvedAt: now,
  };
  const rels = await intelRels();
  const existing = await rels.findOne({ fingerprint: fp });
  if (existing) {
    await rels.updateOne({ fingerprint: fp }, { $set: { ...doc, createdAt: existing.createdAt } });
    await audit(me.sub, 'relationship.upgrade_to_manual', fp);
    await invalidateSchemaCache();
    return NextResponse.json({ ok: true, fingerprint: fp, upgraded: true });
  }
  const r = await rels.insertOne(doc);
  await audit(me.sub, 'relationship.create_manual', fp);
  await invalidateSchemaCache();
  return NextResponse.json({ ok: true, fingerprint: fp, id: String(r.insertedId) }, { status: 201 });
}
