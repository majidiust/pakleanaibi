import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { intelEnumLabels, audit } from '@/lib/intel/storage';
import { invalidateSchemaCache } from '@/lib/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET returns every stored enum-label doc so the chat's EnumHelp popover can
// render the whole set in one round-trip; the payload is tiny (one doc per
// enum-like field). Analyst+admin only, matching the rest of the intel API.
export async function GET() {
  try { await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const coll = await intelEnumLabels();
  const docs = await coll.find({}, { projection: { _id: 0, collection: 1, path: 1, labels: 1, updatedAt: 1 } }).toArray();
  return NextResponse.json({ items: docs });
}

// PATCH upserts labels for a single (collection, path). The whole labels
// object is replaced on each call so removing a value is just omitting its
// key on the next PATCH. Keys are the enum value stringified (numbers and
// booleans go in as-is; strings keep their raw form without quotes).
const Patch = z.object({
  collection: z.string().min(1).max(200),
  path: z.string().min(1).max(200),
  // Per-value labels are short human definitions; cap to 500 chars each and
  // 200 entries per field to bound the payload size. Empty values delete the
  // key on the resulting doc.
  labels: z.record(z.string().max(500)).refine(o => Object.keys(o).length <= 200, {
    message: 'too_many_labels',
  }),
});

export async function PATCH(req: Request) {
  let me;
  try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });

  const { collection, path, labels } = parsed.data;
  // Strip empty-string labels so callers can delete a definition by clearing
  // its input without a dedicated DELETE endpoint.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) {
    const t = v.trim();
    if (t) cleaned[k] = t;
  }

  const coll = await intelEnumLabels();
  const now = new Date();
  await coll.updateOne(
    { collection, path },
    {
      $set: { labels: cleaned, updatedAt: now, updatedBy: me.sub },
      $setOnInsert: { collection, path, createdAt: now },
    },
    { upsert: true },
  );
  await audit(me.sub, 'enumLabels.update', `${collection}.${path}`, { count: Object.keys(cleaned).length });
  // Drop the schema digest cache so the next agentic turn picks up the new
  // labels in the LLM prompt without waiting out the 30-min TTL.
  await invalidateSchemaCache();
  return NextResponse.json({ ok: true, labels: cleaned });
}
