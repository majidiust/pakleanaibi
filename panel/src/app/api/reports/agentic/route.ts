import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Db } from 'mongodb';
import { requireRole } from '@/lib/auth';
import { getSchema, type SchemaDigest } from '@/lib/schema';
import { agenticReport, type ChatMessage, type LlmReport, type AgenticTurn } from '@/lib/llm';
import { validatePipeline, lowerPipeline } from '@/lib/pipeline-guard';
import { dataDb, getServerInfo } from '@/lib/mongo';
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
  maxRepairs: z.number().int().min(0).max(4).optional(),
});

interface Execution {
  ok: boolean;
  rows?: Record<string, unknown>[];
  took?: number;
  count?: number;
  truncated?: boolean;
  error?: string;
}
interface Attempt {
  source: 'initial' | 'repair';
  message: string;
  report: LlmReport;
  execution: Execution;
}

const ALLOWED_DISPLAYS = ['table', 'bar', 'line', 'pie', 'area'] as const;
type DKind = (typeof ALLOWED_DISPLAYS)[number];

// Normalize a partially-formed LLM report into a fully-typed LlmReport, or
// return null when the core fields (collection + non-empty pipeline) are
// missing — the caller should then treat the turn as a question.
function normalizeReport(turn: AgenticTurn): LlmReport | null {
  const r = turn.report;
  const hasCore =
    turn.kind === 'report' &&
    r && typeof r === 'object' &&
    typeof r.collection === 'string' && r.collection.length > 0 &&
    Array.isArray(r.pipeline) && r.pipeline.length > 0;
  if (!hasCore) return null;
  const rawDisplay = (r!.display ?? {}) as Partial<LlmReport['display']> & { kind?: unknown };
  const dKind: DKind = (ALLOWED_DISPLAYS as readonly string[]).includes(rawDisplay.kind as string)
    ? (rawDisplay.kind as DKind) : 'table';
  return {
    collection: r!.collection,
    pipeline: r!.pipeline,
    display: {
      kind: dKind,
      xField: typeof rawDisplay.xField === 'string' ? rawDisplay.xField : undefined,
      yField: typeof rawDisplay.yField === 'string' ? rawDisplay.yField : undefined,
      seriesField: typeof rawDisplay.seriesField === 'string' ? rawDisplay.seriesField : undefined,
      title: typeof rawDisplay.title === 'string' ? rawDisplay.title : undefined,
    },
    explanation: typeof r!.explanation === 'string' && r!.explanation.length > 0
      ? r!.explanation : (turn.message || ''),
    warnings: Array.isArray(r!.warnings) ? r!.warnings.filter((w: unknown): w is string => typeof w === 'string') : [],
  };
}

// Validate + execute a single report. Returns the sealed report (with the
// pipeline as the guard returned it) and an Execution result. Never throws
// — Mongo errors become { ok:false, error }.
async function runReport(db: Db, report: LlmReport, version: [number, number]): Promise<{ sealed: LlmReport; execution: Execution }> {
  let validated;
  try { validated = validatePipeline({ collection: report.collection, pipeline: report.pipeline }); }
  catch (e) {
    return {
      sealed: report,
      execution: { ok: false, error: 'invalid_pipeline: ' + (e instanceof Error ? e.message : String(e)) },
    };
  }
  // Rewrite modern date-math operators into literals for older servers.
  // Surfaces a clear error back to the self-repair loop when something
  // genuinely can't be lowered.
  let lowered: Record<string, unknown>[];
  try { lowered = lowerPipeline(validated.pipeline, version); }
  catch (e) {
    return {
      sealed: { ...report, collection: validated.collection, pipeline: validated.pipeline },
      execution: { ok: false, error: 'unsupported_operator: ' + (e instanceof Error ? e.message : String(e)) },
    };
  }
  const sealed: LlmReport = { ...report, collection: validated.collection, pipeline: lowered };
  const t0 = Date.now();
  try {
    const rows = await db.collection(validated.collection)
      .aggregate(lowered, { maxTimeMS: env.REPORT_MAX_TIME_MS, allowDiskUse: false })
      .toArray();
    return {
      sealed,
      execution: { ok: true, rows, took: Date.now() - t0, count: rows.length, truncated: rows.length >= env.REPORT_MAX_ROWS },
    };
  } catch (e) {
    return { sealed, execution: { ok: false, error: e instanceof Error ? e.message : String(e) } };
  }
}

async function callAgent(
  history: ChatMessage[], lastReport: LlmReport | null, pendingError: string | null,
  digest: SchemaDigest, serverVersion: { major: number; minor: number; raw: string },
): Promise<AgenticTurn | { error: string }> {
  try { return await agenticReport({ history, lastReport, pendingError, serverVersion }, digest); }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

export async function POST(req: Request) {
  try { await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });

  const { history, lastReport, execute = true, maxRepairs = 2 } = parsed.data;
  const [digest, serverInfo] = await Promise.all([getSchema(false), getServerInfo()]);
  const version: [number, number] = [serverInfo.major, serverInfo.minor];
  const history2: ChatMessage[] = history.map(m => ({ role: m.role, content: m.content }));
  const db = await dataDb();

  // --- Initial turn ---------------------------------------------------------
  const first = await callAgent(history2, lastReport ?? null, null, digest, serverInfo);
  if ('error' in first) {
    return NextResponse.json({ error: 'llm_failed', message: first.error }, { status: 502 });
  }
  const firstNormalized = normalizeReport(first);
  if (!firstNormalized) {
    return NextResponse.json({
      kind: 'question',
      message: first.message || 'Could you tell me which collection and time range you have in mind?',
    });
  }
  if (!execute) {
    return NextResponse.json({ kind: 'report', message: first.message, report: firstNormalized, execution: null, repairs: [] });
  }

  const initial = await runReport(db, firstNormalized, version);
  const attempts: Attempt[] = [{ source: 'initial', message: first.message, report: initial.sealed, execution: initial.execution }];

  // --- Self-repair loop -----------------------------------------------------
  // Whenever the latest execution failed, ask the agent to repair using the
  // error as a "pendingError" context hint, then re-execute. Bounded by
  // maxRepairs so we never spin.
  let current = attempts[0];
  for (let i = 0; i < maxRepairs && !current.execution.ok; i++) {
    const errMsg = current.execution.error ?? 'unknown_error';
    const next = await callAgent(history2, current.report, errMsg, digest, serverInfo);
    if ('error' in next) {
      break;
    }
    const norm = normalizeReport(next);
    if (!norm) {
      // The agent gave up on a fix and asked a clarifying question — stop
      // and surface that as the final turn instead of the broken report.
      return NextResponse.json({
        kind: 'question',
        message: next.message || 'I need more information to fix this query.',
        repairs: attempts.slice(1),
      });
    }
    const ran = await runReport(db, norm, version);
    current = { source: 'repair', message: next.message, report: ran.sealed, execution: ran.execution };
    attempts.push(current);
    if (current.execution.ok) break;
  }

  const final = attempts[attempts.length - 1];
  return NextResponse.json({
    kind: 'report',
    message: final.message,
    report: final.report,
    execution: final.execution,
    // Repair attempts in chronological order, excluding the initial turn.
    repairs: attempts.slice(1).map(a => ({ message: a.message, report: a.report, execution: a.execution })),
  });
}
