import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { reportTemplates, intelRels, audit, oid } from '@/lib/intel/storage';
import { applyParameters, detectDrift } from '@/lib/templates';
import { validatePipeline, lowerPipeline } from '@/lib/pipeline-guard';
import { dataDb, getServerInfo } from '@/lib/mongo';
import { env } from '@/lib/env';
import type { IntelReportTemplate } from '@/lib/intel/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  parameters: z.record(z.unknown()).optional(),
  ignoreDrift: z.boolean().optional(),
});

function canRun(doc: IntelReportTemplate, sub: string): boolean {
  return doc.visibility !== 'private' || doc.createdBy === sub;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  let me; try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const _id = oid(params.id);
  if (!_id) return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const coll = await reportTemplates();
  const doc = await coll.findOne({ _id });
  if (!doc) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (!canRun(doc, me.sub)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // Drift gate: any relationship the template was built against that has
  // since been deleted/rejected/archived is reported back. The client can
  // re-submit with ignoreDrift=true to run anyway.
  const relColl = await intelRels();
  const live = await relColl.find(
    { status: { $in: ['approved', 'manual'] } },
    { projection: { _id: 0, fingerprint: 1 } },
  ).toArray().catch(() => []);
  const drift = detectDrift(doc.usedRelationships, live);
  if (drift.missing.length > 0 && !parsed.data.ignoreDrift) {
    return NextResponse.json({
      error: 'drift_detected',
      message: `${drift.missing.length} relationship(s) used by this template are no longer approved.`,
      drift,
    }, { status: 409 });
  }

  // Substitute parameters into a deep clone of the pipeline.
  let resolved: Record<string, unknown>[];
  try {
    resolved = applyParameters(
      doc.pipeline as Record<string, unknown>[],
      doc.parameters ?? [],
      parsed.data.parameters ?? {},
    );
  } catch (e) {
    return NextResponse.json({
      error: 'parameter_error',
      message: e instanceof Error ? e.message : String(e),
    }, { status: 400 });
  }

  // Re-run the same validation + lowering pipeline used by ad-hoc execute.
  let validated;
  try { validated = validatePipeline({ collection: doc.collection, pipeline: resolved }); }
  catch (e) {
    return NextResponse.json({
      error: 'invalid_pipeline',
      message: e instanceof Error ? e.message : String(e),
    }, { status: 422 });
  }
  const info = await getServerInfo();
  let lowered;
  try { lowered = lowerPipeline(validated.pipeline, [info.major, info.minor]); }
  catch (e) {
    return NextResponse.json({
      error: 'unsupported_operator',
      message: e instanceof Error ? e.message : String(e),
    }, { status: 422 });
  }

  const db = await dataDb();
  const t0 = Date.now();
  try {
    const rows = await db.collection(validated.collection)
      .aggregate(lowered, { maxTimeMS: env.REPORT_MAX_TIME_MS, allowDiskUse: false })
      .toArray();
    const took = Date.now() - t0;
    await coll.updateOne({ _id }, {
      $set: {
        lastRunAt: new Date(), lastRunStatus: 'ok',
        lastRunTookMs: took, lastRunRowCount: rows.length,
        lastRunError: undefined,
      },
      $inc: { runCount: 1 },
    });
    await audit(me.sub, 'template.run', params.id, { rows: rows.length, took });
    return NextResponse.json({
      ok: true, rows, took, count: rows.length,
      truncated: rows.length >= env.REPORT_MAX_ROWS,
      display: doc.display,
      drift,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await coll.updateOne({ _id }, {
      $set: {
        lastRunAt: new Date(), lastRunStatus: 'failed',
        lastRunError: msg, lastRunTookMs: Date.now() - t0,
        lastRunRowCount: 0,
      },
      $inc: { runCount: 1 },
    });
    await audit(me.sub, 'template.run.failed', params.id, { error: msg });
    return NextResponse.json({
      error: 'execution_failed', message: msg,
    }, { status: 500 });
  }
}
