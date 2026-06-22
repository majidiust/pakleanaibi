import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { biDb } from '@/lib/mongo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface FavoriteRow {
  _id?: import('mongodb').ObjectId;
  question: string;
  label?: string;
  createdBy: string;
  createdAt: Date;
  hits: number;
  lastUsedAt?: Date;
}

const COLL = 'report_favorites';

async function favs() {
  const db = await biDb();
  const c = db.collection<FavoriteRow>(COLL);
  await c.createIndex({ createdBy: 1, createdAt: -1 });
  await c.createIndex({ createdBy: 1, question: 1 }, { unique: true });
  return c;
}

export async function GET() {
  let me;
  try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const c = await favs();
  const rows = await c.find({ createdBy: me.sub })
    .sort({ hits: -1, createdAt: -1 }).limit(50).toArray();
  return NextResponse.json({
    favorites: rows.map(r => ({
      id: String(r._id), question: r.question, label: r.label,
      hits: r.hits, createdAt: r.createdAt,
    })),
  });
}

const Body = z.object({
  question: z.string().min(3).max(2000),
  label: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  let me;
  try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const c = await favs();
  const now = new Date();
  const r = await c.findOneAndUpdate(
    { createdBy: me.sub, question: parsed.data.question },
    {
      $setOnInsert: {
        question: parsed.data.question, createdBy: me.sub, createdAt: now, hits: 0,
      },
      $set: { label: parsed.data.label },
    },
    { upsert: true, returnDocument: 'after' },
  );
  return NextResponse.json({
    ok: true, id: r ? String(r._id) : null,
  }, { status: 201 });
}
