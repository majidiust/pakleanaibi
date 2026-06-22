import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole, requireUser } from '@/lib/auth';
import { reportTemplates, intelRels, audit } from '@/lib/intel/storage';
import { pipelineCollections, collectUsedRelationships } from '@/lib/templates';
import type { IntelReportTemplate, TemplateVisibility } from '@/lib/intel/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DISPLAY_KINDS = ['table', 'bar', 'line', 'pie', 'area'] as const;
const VISIBILITIES = ['private', 'shared', 'public'] as const;
const PARAM_TYPES = ['string', 'number', 'date', 'boolean', 'objectId'] as const;

const Parameter = z.object({
  key: z.string().regex(/^[A-Za-z_][\w-]*$/).max(40),
  label: z.string().min(1).max(80),
  type: z.enum(PARAM_TYPES),
  defaultValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  options: z.array(z.union([z.string(), z.number()])).max(50).optional(),
  required: z.boolean().optional(),
  description: z.string().max(400).optional(),
});

const Body = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  category: z.string().max(80).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  visibility: z.enum(VISIBILITIES).default('private'),
  connection: z.string().max(60).optional(),
  collection: z.string().min(1).max(120),
  pipeline: z.array(z.record(z.unknown())).min(1).max(40),
  sourcePrompt: z.string().max(4000).optional(),
  outputFields: z.array(z.string().max(120)).max(40).optional(),
  parameters: z.array(Parameter).max(20).optional(),
  defaultSort: z.object({
    field: z.string().min(1).max(120),
    direction: z.union([z.literal(1), z.literal(-1)]),
  }).optional(),
  display: z.object({
    kind: z.enum(DISPLAY_KINDS),
    xField: z.string().max(120).optional(),
    yField: z.string().max(120).optional(),
    seriesField: z.string().max(120).optional(),
    title: z.string().max(160).optional(),
  }),
});

// Lists templates the caller is allowed to see. Visibility rules:
//  - 'private'  : only the owner.
//  - 'shared'   : every authenticated user (read).
//  - 'public'   : same as shared today; reserved for future tenant boundaries.
export async function GET(req: Request) {
  let me; try { me = await requireUser(); } catch (r) { return r as Response; }
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim().toLowerCase() ?? '';
  const category = url.searchParams.get('category')?.trim();
  const tag = url.searchParams.get('tag')?.trim();
  const visibility = url.searchParams.get('visibility') as TemplateVisibility | null;
  const owner = url.searchParams.get('owner'); // 'me' | 'all'
  const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 100));

  const filter: Record<string, unknown> = {
    $or: [{ createdBy: me.sub }, { visibility: { $in: ['shared', 'public'] } }],
  };
  if (visibility) filter.visibility = visibility;
  if (owner === 'me') { delete filter.$or; filter.createdBy = me.sub; }
  if (category) filter.category = category;
  if (tag) filter.tags = tag;
  if (q) {
    filter.$and = [{
      $or: [
        { title: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } },
        { tags: { $regex: q, $options: 'i' } },
      ],
    }];
  }

  const coll = await reportTemplates();
  const docs = await coll.find(filter, {
    projection: { pipeline: 0 }, // keep list responses small
  }).sort({ updatedAt: -1 }).limit(limit).toArray();
  const templates = docs.map(d => ({ ...d, _id: undefined, id: String(d._id) }));
  return NextResponse.json({ templates });
}

export async function POST(req: Request) {
  let me; try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const b = parsed.data;
  const now = new Date();

  // Snapshot the relationships the pipeline relies on so we can warn the
  // user later if any are deleted or changed.
  const relColl = await intelRels();
  const liveRels = await relColl.find(
    { status: { $in: ['approved', 'manual'] } },
    { projection: { _id: 0, fingerprint: 1, source: 1, target: 1, type: 1 } },
  ).toArray().catch(() => []);
  const usedRelationships = collectUsedRelationships(b.collection, b.pipeline, liveRels);
  const usedCollections = pipelineCollections(b.collection, b.pipeline);

  const doc: IntelReportTemplate = {
    title: b.title.trim(),
    description: b.description?.trim(),
    category: b.category?.trim(),
    tags: (b.tags ?? []).map(t => t.trim()).filter(Boolean),
    visibility: b.visibility,
    connection: b.connection ?? 'primary',
    collection: b.collection,
    pipeline: b.pipeline,
    sourcePrompt: b.sourcePrompt,
    usedCollections,
    usedRelationships,
    outputFields: b.outputFields,
    parameters: b.parameters ?? [],
    defaultSort: b.defaultSort,
    display: b.display,
    version: 1,
    createdAt: now, updatedAt: now,
    createdBy: me.sub, updatedBy: me.sub,
    runCount: 0,
  };
  const coll = await reportTemplates();
  const r = await coll.insertOne(doc);
  await audit(me.sub, 'template.create', String(r.insertedId), { title: doc.title });
  return NextResponse.json({ ok: true, id: String(r.insertedId) }, { status: 201 });
}
