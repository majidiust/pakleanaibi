import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { intelColl, intelRels, audit } from '@/lib/intel/storage';
import {
  discoverRelationshipsFromConversation,
  type ChatMessage, type DiscoverContext,
} from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  description: z.string().max(4000).optional(),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(8000),
  })).max(40).default([]),
});

// Build the compact "other collections" view: name + best identifier fields.
// _id is always included; we additionally surface any sampled field with
// uniqueness >= 0.95 and presence >= 0.9 (these are the natural join targets).
interface OtherColl {
  name: string; entity?: string; description?: string;
  idFields: string[]; docCount: number;
}
function buildOthers(all: {
  name: string; entity?: string; description?: string; docCount: number;
  fields: { path: string; uniqueness?: number; presence?: number }[];
}[], exclude: string): OtherColl[] {
  return all.filter(c => c.name !== exclude).map(c => {
    const id = new Set<string>(['_id']);
    for (const f of c.fields) {
      if ((f.uniqueness ?? 0) >= 0.95 && (f.presence ?? 0) >= 0.9 && f.path !== '_id') id.add(f.path);
    }
    return {
      name: c.name, entity: c.entity, description: c.description,
      idFields: [...id], docCount: c.docCount,
    };
  });
}

export async function POST(req: Request, { params }: { params: { name: string } }) {
  let me;
  try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const colls = await intelColl();
  const focused = await colls.findOne({ name: params.name });
  if (!focused) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Persist the user-supplied description on the very first turn so the
  // assistant and downstream UIs see the same text.
  const description = parsed.data.description?.trim();
  if (description && description !== (focused.description ?? '').trim()) {
    await colls.updateOne(
      { name: params.name },
      { $set: { description, descriptionLocked: true, updatedAt: new Date() } },
    );
    focused.description = description;
    focused.descriptionLocked = true;
  }

  const all = await colls.find({}, {
    projection: { name: 1, entity: 1, description: 1, docCount: 1, fields: 1 },
  }).toArray() as unknown as Parameters<typeof buildOthers>[0];

  const rels = await intelRels();
  const existingDocs = await rels.find({
    $or: [{ 'source.collection': params.name }, { 'target.collection': params.name }],
    status: { $in: ['approved', 'manual'] },
  }).project({ source: 1, target: 1, type: 1, status: 1 }).toArray();

  const ctx: DiscoverContext = {
    focused: {
      name: focused.name,
      description: focused.description,
      docCount: focused.docCount ?? 0,
      fields: (focused.fields ?? []).map(f => ({
        path: f.path,
        types: f.types ?? [],
        presence: f.presence ?? 0,
        examples: (f.examples ?? []).slice(0, 2),
        arrayOf: f.arrayOf,
      })),
    },
    others: buildOthers(all, params.name),
    existing: existingDocs.map(e => ({
      source: `${e.source.collection}.${e.source.field}`,
      target: `${e.target.collection}.${e.target.field}`,
      type: e.type, status: e.status,
    })),
    history: parsed.data.history as ChatMessage[],
  };

  try {
    const reply = await discoverRelationshipsFromConversation(ctx);
    await audit(me.sub, 'collection.converse', params.name, {
      turns: parsed.data.history.length,
      suggestions: reply.suggestions.length,
      done: reply.done,
    });
    return NextResponse.json(reply);
  } catch (e) {
    return NextResponse.json({ error: 'llm_failed', detail: String(e) }, { status: 502 });
  }
}
