import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { intelRels, audit, oid } from '@/lib/intel/storage';
import { recordApproval, recordRejection } from '@/lib/intel/learn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REL_TYPES = ['one-to-one','one-to-many','many-to-one','many-to-many','embedded','soft','derived','chain'] as const;

const Patch = z.object({
  status: z.enum(['suggested','approved','rejected','manual','archived']).optional(),
  type: z.enum(REL_TYPES).optional(),
  cardinality: z.enum(['1:1','1:N','N:1','N:N']).optional(),
  notes: z.string().max(4000).optional(),
  tags: z.array(z.string()).max(20).optional(),
  color: z.string().max(20).optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  let me;
  try { me = await requireRole('admin'); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const rels = await intelRels();
  const existing = await rels.findOne({ _id });
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const update: Record<string, unknown> = { ...parsed.data, updatedAt: new Date() };
  if (parsed.data.status === 'approved') {
    update.approvedBy = me.sub; update.approvedAt = new Date();
    await recordApproval(existing, me.sub);
  }
  if (parsed.data.status === 'rejected') {
    update.rejectedBy = me.sub; update.rejectedAt = new Date();
    await recordRejection(existing, me.sub);
  }
  await rels.updateOne({ _id }, { $set: update });
  await audit(me.sub, `relationship.${parsed.data.status ?? 'update'}`, existing.fingerprint, parsed.data);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  let me;
  try { me = await requireRole('admin'); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const rels = await intelRels();
  const existing = await rels.findOne({ _id });
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  await rels.deleteOne({ _id });
  await audit(me.sub, 'relationship.delete', existing.fingerprint);
  return NextResponse.json({ ok: true });
}
