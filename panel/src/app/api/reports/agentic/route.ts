import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { getSchema } from '@/lib/schema';
import { agenticReport, type ChatMessage, type LlmReport } from '@/lib/llm';
import { validatePipeline } from '@/lib/pipeline-guard';
import { dataDb } from '@/lib/mongo';
import { env } from '@/lib/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(4000),
  })).min(1).max(40),
  lastReport: z.object({
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
  }).nullish(),
  execute: z.boolean().optional(),
});

export async function POST(req: Request) {
  try { await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const { history, lastReport, execute = true } = parsed.data;
  const digest = await getSchema(false);
  const history2: ChatMessage[] = history.map(m => ({ role: m.role, content: m.content }));

  let turn;
  try {
    turn = await agenticReport({ history: history2, lastReport: lastReport ?? null }, digest);
  } catch (e) {
    return NextResponse.json({
      error: 'llm_failed',
      message: e instanceof Error ? e.message : String(e),
    }, { status: 502 });
  }

  // Defensive shape check: even when the LLM says kind='report' the report
  // object can be partially formed when strict JSON schema validation isn't
  // enforced server-side. Downgrade malformed reports to a question turn so
  // the UI never crashes on missing nested fields.
  const r = turn.report;
  const validShape =
    turn.kind === 'report' &&
    r && typeof r === 'object' &&
    typeof r.collection === 'string' &&
    Array.isArray(r.pipeline) &&
    r.display && typeof r.display === 'object' &&
    typeof (r.display as { kind?: unknown }).kind === 'string';

  if (!validShape) {
    return NextResponse.json({
      kind: 'question',
      message: turn.message || 'Could you tell me which collection and time range you have in mind?',
    });
  }

  // Normalize the report so downstream consumers can rely on its shape.
  const normalized: LlmReport = {
    collection: r!.collection,
    pipeline: r!.pipeline,
    display: {
      kind: r!.display.kind,
      xField: r!.display.xField,
      yField: r!.display.yField,
      seriesField: r!.display.seriesField,
      title: r!.display.title,
    },
    explanation: typeof r!.explanation === 'string' ? r!.explanation : '',
    warnings: Array.isArray(r!.warnings) ? r!.warnings : [],
  };

  // kind === 'report': validate + (optionally) execute.
  let validated;
  try { validated = validatePipeline({ collection: normalized.collection, pipeline: normalized.pipeline }); }
  catch (e) {
    return NextResponse.json({
      kind: 'report',
      message: turn.message,
      report: normalized,
      execution: {
        ok: false,
        error: 'invalid_pipeline: ' + (e instanceof Error ? e.message : String(e)),
      },
    });
  }
  const sealed: LlmReport = { ...normalized, collection: validated.collection, pipeline: validated.pipeline };

  if (!execute) {
    return NextResponse.json({ kind: 'report', message: turn.message, report: sealed, execution: null });
  }

  const db = await dataDb();
  const t0 = Date.now();
  try {
    const rows = await db.collection(validated.collection)
      .aggregate(validated.pipeline, { maxTimeMS: env.REPORT_MAX_TIME_MS, allowDiskUse: false })
      .toArray();
    return NextResponse.json({
      kind: 'report',
      message: turn.message,
      report: sealed,
      execution: {
        ok: true,
        rows,
        took: Date.now() - t0,
        count: rows.length,
        truncated: rows.length >= env.REPORT_MAX_ROWS,
      },
    });
  } catch (e) {
    return NextResponse.json({
      kind: 'report',
      message: turn.message,
      report: sealed,
      execution: {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      },
    });
  }
}
