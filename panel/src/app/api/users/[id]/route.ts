import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { requireRole, hashPassword } from '@/lib/auth';
import { biDb } from '@/lib/mongo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Patch = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.enum(['admin', 'analyst', 'viewer']).optional(),
  password: z.string().min(8).max(256).optional(),
});

function oid(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  let me;
  try { me = await requireRole('admin'); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.name) update.name = parsed.data.name;
  if (parsed.data.role) update.role = parsed.data.role;
  if (parsed.data.password) update.passwordHash = await hashPassword(parsed.data.password);

  // Prevent admins from locking themselves out by demoting their own account.
  if (parsed.data.role && parsed.data.role !== 'admin' && me.sub === params.id) {
    return NextResponse.json({ error: 'cannot_demote_self' }, { status: 400 });
  }

  const db = await biDb();
  const r = await db.collection('users').updateOne({ _id }, { $set: update });
  if (!r.matchedCount) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  let me;
  try { me = await requireRole('admin'); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  if (me.sub === params.id) {
    return NextResponse.json({ error: 'cannot_delete_self' }, { status: 400 });
  }
  const db = await biDb();
  const r = await db.collection('users').deleteOne({ _id });
  if (!r.deletedCount) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
