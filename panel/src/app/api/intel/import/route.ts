import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { intelColl, intelRels, audit } from '@/lib/intel/storage';
import { relFingerprint } from '@/lib/intel';
import { invalidateSchemaCache } from '@/lib/schema';
import type { IntelRelationship } from '@/lib/intel/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Import accepts JSON only (YAML import is intentionally out of scope to keep
// the panel zero-dependency for parsing). Manual / approved entries always
// overwrite suggestions; rejected entries are preserved.
const Body = z.object({
  collections: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    descriptionLocked: z.boolean().optional(),
    entity: z.string().optional(),
    tags: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })).optional(),
  relationships: z.array(z.object({
    source: z.object({ collection: z.string(), field: z.string(), matchOn: z.string().optional() }),
    target: z.object({ collection: z.string(), field: z.string(), matchOn: z.string().optional() }),
    type: z.string(),
    status: z.enum(['suggested','approved','rejected','manual','archived']).default('manual'),
    notes: z.string().optional(),
    tags: z.array(z.string()).optional(),
    color: z.string().optional(),
    cardinality: z.enum(['1:1','1:N','N:1','N:N']).optional(),
  })).optional(),
});

export async function POST(req: Request) {
  let me;
  try { me = await requireRole('admin'); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });

  const colls = await intelColl();
  const rels = await intelRels();
  let collUpdated = 0, relAdded = 0, relUpdated = 0;
  const now = new Date();

  for (const c of parsed.data.collections ?? []) {
    const r = await colls.updateOne({ name: c.name }, {
      $set: {
        ...(c.description !== undefined && { description: c.description }),
        ...(c.descriptionLocked !== undefined && { descriptionLocked: c.descriptionLocked }),
        ...(c.entity !== undefined && { entity: c.entity }),
        ...(c.tags !== undefined && { tags: c.tags }),
        ...(c.notes !== undefined && { notes: c.notes }),
        updatedAt: now,
      },
    });
    if (r.matchedCount) collUpdated++;
  }

  for (const r of parsed.data.relationships ?? []) {
    const fp = relFingerprint({ source: r.source, target: r.target, type: r.type as IntelRelationship['type'] });
    const existing = await rels.findOne({ fingerprint: fp });
    const doc: Partial<IntelRelationship> = {
      fingerprint: fp, source: r.source, target: r.target,
      type: r.type as IntelRelationship['type'],
      status: r.status, notes: r.notes, tags: r.tags ?? [], color: r.color,
      cardinality: r.cardinality, updatedAt: now,
    };
    if (!existing) {
      const full: IntelRelationship = {
        ...doc as IntelRelationship,
        confidence: r.status === 'manual' ? -1 : 100,
        detection: 'manual', reason: 'Imported.', signals: [{ label: 'imported', weight: 100 }],
        createdAt: now, createdBy: me.sub,
        approvedAt: r.status === 'approved' || r.status === 'manual' ? now : undefined,
        approvedBy: r.status === 'approved' || r.status === 'manual' ? me.sub : undefined,
      };
      await rels.insertOne(full);
      relAdded++;
    } else {
      await rels.updateOne({ fingerprint: fp }, { $set: doc });
      relUpdated++;
    }
  }

  await audit(me.sub, 'import', undefined, { collUpdated, relAdded, relUpdated });
  if (relAdded > 0 || relUpdated > 0) await invalidateSchemaCache();
  return NextResponse.json({ ok: true, collUpdated, relAdded, relUpdated });
}
