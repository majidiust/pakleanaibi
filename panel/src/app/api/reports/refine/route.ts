import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { getSchema } from '@/lib/schema';
import { repairReport, type LlmReport } from '@/lib/llm';
import { validatePipeline } from '@/lib/pipeline-guard';
import { dataDb } from '@/lib/mongo';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ReportSchema = z.object({
  collection: z.string(),
  pipeline: z.array(z.record(z.unknown())),
  display: z.object({
    kind: z.enum(['table', 'bar', 'line', 'pie', 'area']),
    xField: z.string().optional(),
    yField: z.string().optional(),
    seriesField: z.string().optional(),
    title: z.string().optional(),
  }),
  explanation: z.string(),
  warnings: z.array(z.string()).optional(),
});

const Body = z.object({
  question: z.string().min(3).max(2000),
  refinement: z.string().min(2).max(2000),
  previous: ReportSchema,
  execute: z.boolean().optional(),
});

export async function POST(req: Request) {
  try { await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const digest = await getSchema(false);
  const prev = parsed.data.previous as LlmReport;

  let refined: LlmReport;
  try {
    refined = await repairReport({
      question: parsed.data.question,
      previous: prev,
      refinement: parsed.data.refinement,
    }, digest);
  } catch (e) {
    return NextResponse.json({
      error: 'refine_failed',
      message: e instanceof Error ? e.message : String(e),
    }, { status: 500 });
  }

  let validated;
  try { validated = validatePipeline({ collection: refined.collection, pipeline: refined.pipeline }); }
  catch (e) {
    return NextResponse.json({
      error: 'invalid_pipeline',
      message: e instanceof Error ? e.message : 'rejected by guard',
      raw: refined,
    }, { status: 422 });
  }

  const payload = {
    collection: validated.collection,
    pipeline: validated.pipeline,
    display: refined.display,
    explanation: refined.explanation,
    warnings: refined.warnings ?? [],
  };

  if (!parsed.data.execute) return NextResponse.json(payload);

  // Optional same-call execution.
  const db = await dataDb();
  const t0 = Date.now();
  try {
    const rows = await db.collection(validated.collection)
      .aggregate(validated.pipeline, { maxTimeMS: env.REPORT_MAX_TIME_MS, allowDiskUse: false })
      .toArray();
    return NextResponse.json({
      ...payload,
      rows, took: Date.now() - t0, count: rows.length,
      truncated: rows.length >= env.REPORT_MAX_ROWS,
    });
  } catch (e) {
    return NextResponse.json({
      ...payload,
      error: 'execution_failed',
      message: e instanceof Error ? e.message : String(e),
    }, { status: 200 });
  }
}
