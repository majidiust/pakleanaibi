import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth';
import { reportTemplates, audit, oid } from '@/lib/intel/storage';
import type { IntelReportTemplate } from '@/lib/intel/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  let me; try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const coll = await reportTemplates();
  const src = await coll.findOne({ _id });
  if (!src) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  // Anyone allowed to read may duplicate; the copy is owned by the caller
  // and starts out private regardless of the source's visibility.
  if (src.visibility === 'private' && src.createdBy !== me.sub) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const now = new Date();
  const copy: IntelReportTemplate = {
    title: `${src.title} (copy)`,
    description: src.description,
    category: src.category,
    tags: [...(src.tags ?? [])],
    visibility: 'private',
    connection: src.connection,
    collection: src.collection,
    pipeline: src.pipeline,
    sourcePrompt: src.sourcePrompt,
    usedCollections: src.usedCollections,
    usedRelationships: src.usedRelationships,
    outputFields: src.outputFields,
    parameters: src.parameters,
    defaultSort: src.defaultSort,
    display: src.display,
    version: 1,
    createdAt: now, updatedAt: now,
    createdBy: me.sub, updatedBy: me.sub,
    runCount: 0,
  };
  const r = await coll.insertOne(copy);
  await audit(me.sub, 'template.duplicate', params.id, { newId: String(r.insertedId) });
  return NextResponse.json({ ok: true, id: String(r.insertedId) }, { status: 201 });
}
