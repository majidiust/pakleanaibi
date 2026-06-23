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
  // See note in [id]/route.ts — kept in sync so the picker survives reload.
  needs: z.object({
    type: z.enum(['date', 'dateRange']),
    label: z.string().max(200).optional(),
    field: z.string().max(120).optional(),
  }).optional(),
});

// The lastReport shape mirrors LlmReport but is kept loose here: we only
// round-trip it back to the client, never re-execute server-side from this
// route, so strict validation lives on the agentic POST handler instead.
const Body = z.object({
  title: z.string().max(160).optional(),
  description: z.string().max(2000).optional(),
  history: z.array(ChatMsg).max(400).optional(),
  lastReport: z.record(z.unknown()).nullable().optional(),
});

function derivedTitle(history: z.infer<typeof ChatMsg>[] | undefined): string {
  const first = history?.find(m => m.role === 'user' && m.content.trim().length > 0);
  if (!first) return 'New conversation';
  const t = first.content.trim().replace(/\s+/g, ' ').slice(0, 80);
  return t.length > 0 ? t : 'New conversation';
}

export async function GET() {
  let me; try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const db = await biDb();
  // Project away the heavy fields (history + lastReport) for the list view;
  // the detail GET hydrates them on demand when the user opens a conversation.
  const rows = await db.collection('agentic_conversations')
    .find({ userId: me.sub }, { projection: { history: 0, lastReport: 0 } })
    .sort({ updatedAt: -1 })
    .limit(100)
    .toArray();
  return NextResponse.json({
    conversations: rows.map(r => ({
      id: String(r._id),
      title: r.title ?? 'Untitled',
      description: r.description ?? '',
      messageCount: r.messageCount ?? 0,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  });
}

export async function POST(req: Request) {
  let me; try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues.slice(0, 5) }, { status: 400 });
  }
  const now = new Date();
  const history = parsed.data.history ?? [];
  const doc = {
    _id: new ObjectId(),
    userId: me.sub,
    title: parsed.data.title?.trim() || derivedTitle(history),
    description: parsed.data.description?.trim() ?? '',
    history,
    lastReport: parsed.data.lastReport ?? null,
    messageCount: history.length,
    createdAt: now,
    updatedAt: now,
  };
  const db = await biDb();
  await db.collection('agentic_conversations').insertOne(doc);
  return NextResponse.json({
    id: String(doc._id),
    title: doc.title,
    description: doc.description,
    messageCount: doc.messageCount,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }, { status: 201 });
}
