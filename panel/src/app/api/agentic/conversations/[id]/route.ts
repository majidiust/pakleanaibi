import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ObjectId } from 'mongodb';
import { requireRole } from '@/lib/auth';
import { biDb } from '@/lib/mongo';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ChatMsg = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(16000),
  kind: z.enum(['question', 'report', 'repair']).optional(),
  // Optional structured hint attached to a question turn (date picker, etc.)
  // so the latest unanswered question still renders its inline UI after a
  // page reload.
  needs: z.object({
    type: z.enum(['date', 'dateRange']),
    label: z.string().max(200).optional(),
    field: z.string().max(120).optional(),
  }).optional(),
});

const Patch = z.object({
  title: z.string().min(1).max(160).optional(),
  description: z.string().max(2000).optional(),
  history: z.array(ChatMsg).max(400).optional(),
  lastReport: z.record(z.unknown()).nullable().optional(),
});

function oid(s: string): ObjectId | null {
  return ObjectId.isValid(s) ? new ObjectId(s) : null;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  let me; try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const db = await biDb();
  const doc = await db.collection('agentic_conversations').findOne({ _id, userId: me.sub });
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({
    id: String(doc._id),
    title: doc.title ?? 'Untitled',
    description: doc.description ?? '',
    history: doc.history ?? [],
    lastReport: doc.lastReport ?? null,
    messageCount: doc.messageCount ?? 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  let me; try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  }
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (parsed.data.title !== undefined) set.title = parsed.data.title.trim();
  if (parsed.data.description !== undefined) set.description = parsed.data.description.trim();
  if (parsed.data.history !== undefined) {
    set.history = parsed.data.history;
    set.messageCount = parsed.data.history.length;
  }
  if (parsed.data.lastReport !== undefined) set.lastReport = parsed.data.lastReport;
  const db = await biDb();
  const r = await db.collection('agentic_conversations').updateOne(
    { _id, userId: me.sub }, { $set: set },
  );
  if (r.matchedCount === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true, updatedAt: set.updatedAt });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  let me; try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const db = await biDb();
  const r = await db.collection('agentic_conversations').deleteOne({ _id, userId: me.sub });
  if (r.deletedCount === 0) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
