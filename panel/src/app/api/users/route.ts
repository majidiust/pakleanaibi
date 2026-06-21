import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole, hashPassword } from '@/lib/auth';
import { biDb } from '@/lib/mongo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Create = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(120),
  role: z.enum(['admin', 'analyst', 'viewer']),
  password: z.string().min(8).max(256),
});

export async function GET() {
  try { await requireRole('admin'); } catch (r) { return r as Response; }
  const db = await biDb();
  const docs = await db.collection('users')
    .find({}, { projection: { passwordHash: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
  return NextResponse.json({
    users: docs.map(d => ({ ...d, id: String(d._id), _id: undefined })),
  });
}

export async function POST(req: Request) {
  try { await requireRole('admin'); } catch (r) { return r as Response; }
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const { email, name, role, password } = parsed.data;
  const db = await biDb();
  const dup = await db.collection('users').findOne({ email: email.toLowerCase() });
  if (dup) return NextResponse.json({ error: 'email_taken' }, { status: 409 });
  const now = new Date();
  const r = await db.collection('users').insertOne({
    email: email.toLowerCase(),
    name,
    role,
    passwordHash: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  });
  return NextResponse.json({ id: String(r.insertedId) }, { status: 201 });
}
