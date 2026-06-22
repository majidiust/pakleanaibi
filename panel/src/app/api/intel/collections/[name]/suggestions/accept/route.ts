import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { intelColl, intelRels, audit } from '@/lib/intel/storage';
import { relFingerprint } from '@/lib/intel';
import { invalidateSchemaCache } from '@/lib/schema';
import type { IntelRelationship } from '@/lib/intel/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REL_TYPES = ['one-to-one','one-to-many','many-to-one','many-to-many','embedded','soft','derived','chain'] as const;

const Body = z.object({
  source: z.object({ collection: z.string(), field: z.string() }),
  target: z.object({ collection: z.string(), field: z.string(), matchOn: z.string().optional() }),
  type: z.enum(REL_TYPES),
  cardinality: z.enum(['1:1','1:N','N:1','N:N']).optional(),
  confidence: z.number().min(0).max(100).optional(),
  reason: z.string().max(2000).optional(),
  signals: z.array(z.string().max(160)).max(20).optional(),
});

export async function POST(req: Request, { params }: { params: { name: string } }) {
  let me;
  try { me = await requireRole('admin'); } catch (r) { return r as Response; }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const body = parsed.data;

  // Strict guard: the AI must operate on the focused collection.
  if (body.source.collection !== params.name) {
    return NextResponse.json({ error: 'source_mismatch' }, { status: 400 });
  }

  // Validate that source + target collections exist before saving.
  const colls = await intelColl();
  const [src, tgt] = await Promise.all([
    colls.findOne({ name: body.source.collection }, { projection: { name: 1 } }),
    colls.findOne({ name: body.target.collection }, { projection: { name: 1 } }),
  ]);
  if (!src || !tgt) return NextResponse.json({ error: 'unknown_collection' }, { status: 400 });

  const now = new Date();
  const fp = relFingerprint({ source: body.source, target: body.target, type: body.type });
  const signals = (body.signals ?? []).map((label, i) => ({ label, weight: Math.max(1, 10 - i) }));
  signals.unshift({ label: 'ai-conversation', weight: 30 });

  const doc: IntelRelationship = {
    fingerprint: fp,
    source: body.source,
    target: body.target,
    type: body.type,
    cardinality: body.cardinality,
    status: 'approved',
    confidence: body.confidence ?? 80,
    detection: 'learned',
    reason: body.reason ?? 'Approved from AI-assisted relationship discovery.',
    signals,
    tags: ['ai-assistant'],
    createdAt: now, updatedAt: now,
    createdBy: me.sub,
    approvedBy: me.sub, approvedAt: now,
  };

  const rels = await intelRels();
  const existing = await rels.findOne({ fingerprint: fp });
  if (existing) {
    // Don't downgrade a manual entry; otherwise refresh + mark approved.
    if (existing.status === 'manual') {
      return NextResponse.json({ ok: true, fingerprint: fp, kept: 'manual' });
    }
    await rels.updateOne(
      { fingerprint: fp },
      {
        $set: {
          status: 'approved',
          confidence: doc.confidence,
          reason: doc.reason,
          signals: doc.signals,
          cardinality: doc.cardinality,
          updatedAt: now,
          approvedBy: me.sub,
          approvedAt: now,
        },
      },
    );
    await audit(me.sub, 'relationship.approve_via_ai', fp);
    await invalidateSchemaCache();
    return NextResponse.json({ ok: true, fingerprint: fp, upgraded: true });
  }

  const r = await rels.insertOne(doc);
  await audit(me.sub, 'relationship.create_via_ai', fp);
  await invalidateSchemaCache();
  return NextResponse.json({ ok: true, fingerprint: fp, id: String(r.insertedId) }, { status: 201 });
}
