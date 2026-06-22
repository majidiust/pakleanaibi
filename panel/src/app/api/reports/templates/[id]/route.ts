import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole, requireUser } from '@/lib/auth';
import {
  reportTemplates, reportTemplateVersions, intelRels, audit, oid,
} from '@/lib/intel/storage';
import {
  pipelineCollections, collectUsedRelationships, detectDrift,
} from '@/lib/templates';
import type { IntelReportTemplate } from '@/lib/intel/types';

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

const Patch = z.object({
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  category: z.string().max(80).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  collection: z.string().min(1).max(120).optional(),
  pipeline: z.array(z.record(z.unknown())).min(1).max(40).optional(),
  sourcePrompt: z.string().max(4000).optional(),
  outputFields: z.array(z.string().max(120)).max(40).optional(),
  parameters: z.array(Parameter).max(20).optional(),
  defaultSort: z.object({
    field: z.string().min(1).max(120),
    direction: z.union([z.literal(1), z.literal(-1)]),
  }).nullable().optional(),
  display: z.object({
    kind: z.enum(DISPLAY_KINDS),
    xField: z.string().max(120).optional(),
    yField: z.string().max(120).optional(),
    seriesField: z.string().max(120).optional(),
    title: z.string().max(160).optional(),
  }).optional(),
  versionNote: z.string().max(400).optional(),
});

function canRead(doc: IntelReportTemplate, sub: string): boolean {
  return doc.visibility !== 'private' || doc.createdBy === sub;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  let me; try { me = await requireUser(); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const coll = await reportTemplates();
  const doc = await coll.findOne({ _id });
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!canRead(doc, me.sub)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // Compute drift on read so the detail page can render the warning without
  // a second round-trip. Cheap: relationships are a small in-memory list.
  const relColl = await intelRels();
  const live = await relColl.find(
    { status: { $in: ['approved', 'manual'] } },
    { projection: { _id: 0, fingerprint: 1 } },
  ).toArray().catch(() => []);
  const drift = detectDrift(doc.usedRelationships, live);

  return NextResponse.json({
    template: { ...doc, _id: undefined, id: String(doc._id) },
    drift,
  });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  let me; try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });

  const coll = await reportTemplates();
  const existing = await coll.findOne({ _id });
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  // Only the owner or an admin may modify the body.
  if (existing.createdBy !== me.sub && me.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const now = new Date();
  const b = parsed.data;
  // Detect whether this edit touches the actual query body. If so, snapshot
  // the previous body to report_template_versions and bump `version`.
  const bodyChanged = b.pipeline !== undefined || b.collection !== undefined ||
    b.parameters !== undefined || b.display !== undefined;

  const set: Record<string, unknown> = { updatedAt: now, updatedBy: me.sub };
  if (b.title !== undefined) set.title = b.title.trim();
  if (b.description !== undefined) set.description = b.description.trim();
  if (b.category !== undefined) set.category = b.category.trim();
  if (b.tags !== undefined) set.tags = b.tags.map(t => t.trim()).filter(Boolean);
  if (b.visibility !== undefined) set.visibility = b.visibility;
  if (b.collection !== undefined) set.collection = b.collection;
  if (b.pipeline !== undefined) set.pipeline = b.pipeline;
  if (b.sourcePrompt !== undefined) set.sourcePrompt = b.sourcePrompt;
  if (b.outputFields !== undefined) set.outputFields = b.outputFields;
  if (b.parameters !== undefined) set.parameters = b.parameters;
  if (b.defaultSort !== undefined) set.defaultSort = b.defaultSort ?? undefined;
  if (b.display !== undefined) set.display = b.display;

  if (bodyChanged) {
    const newColl = b.collection ?? existing.collection;
    const newPipeline = b.pipeline ?? existing.pipeline;
    const relColl = await intelRels();
    const liveRels = await relColl.find(
      { status: { $in: ['approved', 'manual'] } },
      { projection: { _id: 0, fingerprint: 1, source: 1, target: 1, type: 1 } },
    ).toArray().catch(() => []);
    set.usedCollections = pipelineCollections(newColl, newPipeline);
    set.usedRelationships = collectUsedRelationships(newColl, newPipeline, liveRels);
    set.version = (existing.version ?? 1) + 1;

    const versions = await reportTemplateVersions();
    await versions.insertOne({
      templateId: _id,
      version: existing.version ?? 1,
      takenAt: now,
      takenBy: me.sub,
      snapshot: {
        title: existing.title, description: existing.description,
        category: existing.category, tags: existing.tags,
        visibility: existing.visibility,
        collection: existing.collection, pipeline: existing.pipeline,
        parameters: existing.parameters, display: existing.display,
        usedCollections: existing.usedCollections,
        usedRelationships: existing.usedRelationships,
        outputFields: existing.outputFields,
        defaultSort: existing.defaultSort,
        sourcePrompt: existing.sourcePrompt,
      },
      note: b.versionNote,
    });
  }

  await coll.updateOne({ _id }, { $set: set });
  await audit(me.sub, 'template.update', params.id, { bodyChanged });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  let me; try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const coll = await reportTemplates();
  const existing = await coll.findOne({ _id });
  if (!existing) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (existing.createdBy !== me.sub && me.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  await coll.deleteOne({ _id });
  const versions = await reportTemplateVersions();
  await versions.deleteMany({ templateId: _id });
  await audit(me.sub, 'template.delete', params.id, { title: existing.title });
  return NextResponse.json({ ok: true });
}
