import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { getSchema } from '@/lib/schema';
import { generateReport, type LlmReport } from '@/lib/llm';
import { validatePipeline } from '@/lib/pipeline-guard';
import { biDb } from '@/lib/mongo';
import { env } from '@/lib/env';
import { lookup as cacheLookup, store as cacheStore } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  question: z.string().min(3).max(2000),
  save: z.boolean().optional(),
  skipCache: z.boolean().optional(),
});

export async function POST(req: Request) {
  let me;
  try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const digest = await getSchema(false);
  const schemaVersion = digest.generatedAt;

  // 1) Cache lookup (exact + optional semantic). Saves a paid LLM call.
  let cacheInfo: { matchType: 'exact' | 'semantic'; similarity?: number; cachedAt: Date } | null = null;
  let llm: LlmReport | null = null;
  if (!parsed.data.skipCache) {
    const hit = await cacheLookup(parsed.data.question, schemaVersion, env.OPENAI_MODEL);
    if (hit) { llm = hit.report; cacheInfo = { matchType: hit.matchType, similarity: hit.similarity, cachedAt: hit.cachedAt }; }
  }
  // 2) Cache miss -> call OpenAI.
  if (!llm) llm = await generateReport(parsed.data.question, digest);

  // 3) Validate before returning so the UI receives a safe payload either way.
  let validated;
  try { validated = validatePipeline({ collection: llm.collection, pipeline: llm.pipeline }); }
  catch (e) {
    return NextResponse.json({
      error: 'invalid_pipeline',
      message: e instanceof Error ? e.message : 'rejected by guard',
      raw: llm,
    }, { status: 422 });
  }

  // 4) Store on cache miss only.
  if (!cacheInfo) {
    await cacheStore({
      question: parsed.data.question,
      schemaVersion,
      model: env.OPENAI_MODEL,
      report: { ...llm, collection: validated.collection, pipeline: validated.pipeline },
    });
  }

  if (parsed.data.save) {
    const db = await biDb();
    await db.collection('reports').insertOne({
      question: parsed.data.question,
      collection: validated.collection,
      pipeline: validated.pipeline,
      display: llm.display,
      explanation: llm.explanation,
      createdAt: new Date(),
      createdBy: me.sub,
    });
  }

  return NextResponse.json({
    collection: validated.collection,
    pipeline: validated.pipeline,
    display: llm.display,
    explanation: llm.explanation,
    warnings: llm.warnings ?? [],
    cache: cacheInfo,
  });
}
