import { NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { requireRole } from '@/lib/auth';
import { biDb } from '@/lib/mongo';
import { diffPipelines, summariseDiff } from '@/lib/pipeline-diff';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Stage-level diff between two persisted versions of the same conversation.
// Used by the versions tree UI's "Compare" action. Returns both the
// structural diff payload (computed by pipeline-diff.ts) and a short human
// summary so the client can render either a one-line description or the
// detailed stage-by-stage breakdown without re-computing on every render.
// Only the user that owns the conversation can read it; foreign access
// yields a 404 (never a 403) to avoid leaking conversation existence.
interface PersistedVersion {
  id: string;
  collection: string;
  pipeline: Record<string, unknown>[];
  createdAt?: Date | string;
  triggerMessage?: string;
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  let me; try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  if (!ObjectId.isValid(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }
  const url = new URL(req.url);
  const aId = url.searchParams.get('a');
  const bId = url.searchParams.get('b');
  if (!aId || !bId) {
    return NextResponse.json({ error: 'missing_version_ids' }, { status: 400 });
  }

  const db = await biDb();
  const doc = await db.collection<{ versions?: PersistedVersion[] }>('agentic_conversations').findOne(
    { _id: new ObjectId(params.id), userId: me.sub },
    { projection: { versions: 1 } },
  );
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const versions = doc.versions ?? [];
  const a = versions.find(v => v.id === aId);
  const b = versions.find(v => v.id === bId);
  if (!a || !b) {
    return NextResponse.json({ error: 'version_not_found' }, { status: 404 });
  }
  const diff = diffPipelines(a.collection, a.pipeline, b.collection, b.pipeline);
  return NextResponse.json({
    a: { id: a.id, collection: a.collection, pipeline: a.pipeline, createdAt: a.createdAt ?? null, triggerMessage: a.triggerMessage ?? '' },
    b: { id: b.id, collection: b.collection, pipeline: b.pipeline, createdAt: b.createdAt ?? null, triggerMessage: b.triggerMessage ?? '' },
    diff,
    summary: summariseDiff(diff),
  });
}
