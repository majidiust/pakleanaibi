import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { dataDb } from '@/lib/mongo';
import { validatePipeline } from '@/lib/pipeline-guard';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  collection: z.string().min(1).max(120),
  pipeline: z.array(z.record(z.unknown())).min(1).max(24),
});

export async function POST(req: Request) {
  try { await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  let v;
  try { v = validatePipeline(parsed.data); }
  catch (e) {
    return NextResponse.json({
      error: 'invalid_pipeline',
      message: e instanceof Error ? e.message : 'rejected',
    }, { status: 422 });
  }

  const db = await dataDb();
  const t0 = Date.now();
  try {
    const rows = await db.collection(v.collection)
      .aggregate(v.pipeline, { maxTimeMS: env.REPORT_MAX_TIME_MS, allowDiskUse: false })
      .toArray();
    return NextResponse.json({
      rows,
      took: Date.now() - t0,
      count: rows.length,
      truncated: rows.length >= env.REPORT_MAX_ROWS,
    });
  } catch (e) {
    return NextResponse.json({
      error: 'execution_failed',
      message: e instanceof Error ? e.message : String(e),
    }, { status: 500 });
  }
}
