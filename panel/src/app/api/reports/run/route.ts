import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth';
import { getSchema } from '@/lib/schema';
import { generateReport, repairReport, type LlmReport } from '@/lib/llm';
import { validatePipeline, lowerPipeline } from '@/lib/pipeline-guard';
import { dataDb, getServerInfo } from '@/lib/mongo';
import { env } from '@/lib/env';
import { lookup as cacheLookup, store as cacheStore } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  question: z.string().min(3).max(2000),
  skipCache: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
});

interface Attempt {
  n: number;
  source: 'cache' | 'llm' | 'repair';
  collection: string;
  pipeline: Record<string, unknown>[];
  display: LlmReport['display'];
  explanation: string;
  warnings: string[];
  ok: boolean;
  error?: string;          // MongoDB error if execution failed.
  rows?: Record<string, unknown>[];
  took?: number;
  count?: number;
  truncated?: boolean;
  cache?: { matchType: 'exact' | 'semantic'; similarity?: number; cachedAt: Date } | null;
}

export async function POST(req: Request) {
  try { await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const { question, skipCache, maxAttempts = 3 } = parsed.data;
  const digest = await getSchema(false);
  const schemaVersion = digest.generatedAt;

  // First report: cache → LLM.
  let cacheInfo: Attempt['cache'] = null;
  let report: LlmReport | null = null;
  if (!skipCache) {
    const hit = await cacheLookup(question, schemaVersion, env.OPENAI_MODEL);
    if (hit) { report = hit.report; cacheInfo = { matchType: hit.matchType, similarity: hit.similarity, cachedAt: hit.cachedAt }; }
  }
  let source: Attempt['source'] = cacheInfo ? 'cache' : 'llm';
  if (!report) report = await generateReport(question, digest);

  const attempts: Attempt[] = [];
  const db = await dataDb();
  const info = await getServerInfo();
  const version: [number, number] = [info.major, info.minor];

  for (let i = 1; i <= maxAttempts; i++) {
    // Validate (sanitizes keys, enforces allowlist, forces final $limit).
    let validated;
    try { validated = validatePipeline({ collection: report.collection, pipeline: report.pipeline }); }
    catch (e) {
      attempts.push({
        n: i, source,
        collection: report.collection, pipeline: report.pipeline,
        display: report.display, explanation: report.explanation,
        warnings: report.warnings ?? [],
        ok: false,
        error: 'invalid_pipeline: ' + (e instanceof Error ? e.message : String(e)),
        cache: i === 1 ? cacheInfo : null,
      });
      if (i >= maxAttempts) break;
      // Try to repair the guard rejection too.
      report = await repairReport({
        question, previous: report,
        error: attempts[attempts.length - 1].error!,
      }, digest);
      source = 'repair';
      continue;
    }

    // Lower modern date operators for the target server version.
    let lowered;
    try { lowered = lowerPipeline(validated.pipeline, version); }
    catch (e) {
      const msg = 'unsupported_operator: ' + (e instanceof Error ? e.message : String(e));
      attempts.push({
        n: i, source,
        collection: validated.collection, pipeline: validated.pipeline,
        display: report.display, explanation: report.explanation,
        warnings: report.warnings ?? [], ok: false, error: msg,
        cache: i === 1 ? cacheInfo : null,
      });
      if (i >= maxAttempts) break;
      report = await repairReport({ question, previous: report, error: msg }, digest);
      source = 'repair';
      continue;
    }

    // Execute.
    const t0 = Date.now();
    try {
      const rows = await db.collection(validated.collection)
        .aggregate(lowered, { maxTimeMS: env.REPORT_MAX_TIME_MS, allowDiskUse: false })
        .toArray();
      const took = Date.now() - t0;
      attempts.push({
        n: i, source,
        collection: validated.collection, pipeline: validated.pipeline,
        display: report.display, explanation: report.explanation,
        warnings: report.warnings ?? [],
        ok: true, rows, took, count: rows.length,
        truncated: rows.length >= env.REPORT_MAX_ROWS,
        cache: i === 1 ? cacheInfo : null,
      });
      // Cache only the first successful + cache-miss answer.
      if (i === 1 && !cacheInfo) {
        await cacheStore({
          question, schemaVersion, model: env.OPENAI_MODEL,
          report: { ...report, collection: validated.collection, pipeline: validated.pipeline },
        });
      }
      return NextResponse.json({ final: 'ok', attempts });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      attempts.push({
        n: i, source,
        collection: validated.collection, pipeline: validated.pipeline,
        display: report.display, explanation: report.explanation,
        warnings: report.warnings ?? [],
        ok: false, error: msg,
        cache: i === 1 ? cacheInfo : null,
      });
      if (i >= maxAttempts) break;
      // Auto-repair using the error feedback.
      try {
        report = await repairReport({ question, previous: report, error: msg }, digest);
        source = 'repair';
      } catch (e2) {
        attempts.push({
          n: i + 1, source: 'repair',
          collection: validated.collection, pipeline: validated.pipeline,
          display: report.display, explanation: report.explanation,
          warnings: report.warnings ?? [], ok: false,
          error: 'repair_failed: ' + (e2 instanceof Error ? e2.message : String(e2)),
          cache: null,
        });
        break;
      }
    }
  }

  return NextResponse.json({ final: 'failed', attempts });
}
