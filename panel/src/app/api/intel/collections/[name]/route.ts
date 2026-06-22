import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { intelColl, intelRels, audit } from '@/lib/intel/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: { name: string } }) {
  try { await requireRole('admin', 'analyst', 'viewer'); } catch (r) { return r as Response; }
  const [colls, rels] = await Promise.all([intelColl(), intelRels()]);
  const c = await colls.findOne({ name: params.name });
  if (!c) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const [outgoing, incoming] = await Promise.all([
    rels.find({ 'source.collection': params.name }).sort({ confidence: -1 }).toArray(),
    rels.find({ 'target.collection': params.name }).sort({ confidence: -1 }).toArray(),
  ]);
  return NextResponse.json({
    collection: { ...c, _id: undefined, id: String(c._id) },
    outgoing: outgoing.map(r => ({ ...r, _id: undefined, id: String(r._id) })),
    incoming: incoming.map(r => ({ ...r, _id: undefined, id: String(r._id) })),
  });
}

const Patch = z.object({
  description: z.string().max(2000).optional(),
  descriptionLocked: z.boolean().optional(),
  entity: z.string().max(80).optional(),
  label: z.string().max(120).optional(),
  notes: z.string().max(4000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export async function PATCH(req: Request, { params }: { params: { name: string } }) {
  let me;
  try { me = await requireRole('admin'); } catch (r) { return r as Response; }
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const colls = await intelColl();
  const r = await colls.updateOne(
    { name: params.name },
    { $set: { ...parsed.data, updatedAt: new Date() } },
  );
  if (!r.matchedCount) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  await audit(me.sub, 'collection.update', params.name, parsed.data);
  return NextResponse.json({ ok: true });
}
