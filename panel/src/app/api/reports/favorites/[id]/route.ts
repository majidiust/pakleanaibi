import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ObjectId } from 'mongodb';
import { requireRole } from '@/lib/auth';
import { biDb } from '@/lib/mongo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLL = 'report_favorites';

function oid(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

const Patch = z.object({
  label: z.string().max(120).optional(),
  // POST-as-use: bump hit counter when invoked from the picker.
  used: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  let me;
  try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const db = await biDb();
  const c = db.collection(COLL);
  const update: Record<string, unknown> = {};
  if (parsed.data.label !== undefined) update.$set = { label: parsed.data.label };
  if (parsed.data.used) {
    update.$inc = { hits: 1 };
    update.$set = { ...(update.$set as object | undefined), lastUsedAt: new Date() };
  }
  if (Object.keys(update).length === 0) return NextResponse.json({ ok: true });
  const r = await c.updateOne({ _id, createdBy: me.sub }, update);
  if (!r.matchedCount) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  let me;
  try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const db = await biDb();
  const r = await db.collection(COLL).deleteOne({ _id, createdBy: me.sub });
  if (!r.deletedCount) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
