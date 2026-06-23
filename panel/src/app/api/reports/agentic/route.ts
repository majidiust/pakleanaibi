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

// History/content limits are deliberately generous: assistant messages can be
// long (full plan + per-repair verdict) and conversations can accumulate
// quickly. The route trims to a sliding window before calling the LLM, so
// these caps only exist to reject obviously malformed payloads.
const Body = z.object({
  // Allow empty content here: assistant turns that were pure-report (the LLM
  // put everything in report.explanation and left `message` blank) ended up
  // stored client-side with content=''. Rejecting them would brick those
  // existing sessions. We filter empties out before calling the LLM below.
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().max(16000),
  })).min(1).max(200),
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

// Keep the prompt focused on the most recent exchanges. Earlier turns are
// summarised by the `lastReport` snapshot the client sends anyway, so we
// don't lose useful state by dropping them.
const HISTORY_WINDOW = 24;

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

// Add actionable, pattern-specific guidance on top of the raw MongoDB
// error so the repair turn produces a different PLAN, not just a tweaked
// version of the same broken one. The raw "exceeded time limit" string
// has no information the agent can act on otherwise.
function enrichError(raw: string, broken: LlmReport): string {
  const lower = raw.toLowerCase();
  const hints: string[] = [];
  // Plan-level timeout almost always means the pipeline scanned a large
  // collection before filtering. Detect the classic anti-pattern and
  // tell the model how to rewrite it.
  if (lower.includes('exceeded time limit') || lower.includes('planexecutor') || lower.includes('maxtimems')) {
    const stages = (broken.pipeline as Record<string, unknown>[]).map(s => Object.keys(s)[0]);
    const firstLookup = stages.indexOf('$lookup');
    const firstMatch = stages.indexOf('$match');
    const anchoredOnLookup = firstLookup >= 0 && (firstMatch === -1 || firstLookup < firstMatch);
    hints.push(
      'The query exceeded the execution time limit. This is almost always a PLAN problem, not a syntax problem.',
      'Re-read the PIPELINE PLANNING rules and the JOIN RECIPES in the schema. Anchor the pipeline on the collection whose filter is MOST SELECTIVE, narrow it FIRST with $match/$sort/$limit, and only THEN $lookup the related rows using the reverse JOIN RECIPE if needed.',
    );
    if (anchoredOnLookup) {
      hints.push(
        'Your previous pipeline started with $lookup before $match. That scans the entire anchor collection and joins every row before filtering. Swap the anchor: pick the collection that owns the filter field, apply $match + $sort + $limit on it FIRST, then $lookup the other side using the reverse recipe.',
      );
    }
  }
  if (lower.includes('cannot convert') || lower.includes('failed to parse date') || lower.includes('not a date')) {
    hints.push(
      'A date comparison failed because the right-hand side was a string and the left-hand side is a BSON Date (or vice versa). Always emit dates as EJSON {"$date": "<ISO with Z>"} so the driver serialises a real BSON Date.',
    );
  }
  // Malformed expression shape — the model serialised an operator and its
  // arguments into the KEY of an object (e.g. `"$eq:["` ... or a duplicate
  // `$eq` key inside an `$and`). MongoDB reports this as "must have exactly
  // one field" / "Unrecognized expression"; the pipeline-guard now catches
  // most cases earlier with "Malformed operator key" but we want the same
  // explicit hint either way so the repair turn rebuilds the expression
  // tree from scratch rather than micro-editing the broken keys.
  if (
    lower.includes('must have exactly one field') ||
    lower.includes('unrecognized expression') ||
    lower.includes('malformed operator key')
  ) {
    hints.push(
      'The previous pipeline had a malformed expression: operator name and arguments were merged into a single object key (e.g. {"$eq:[": ...}) or `&and` was emitted instead of `$and`.',
      'JSON SHAPE RULE: every operator is a CLEAN top-level key whose VALUE is the argument list, never inside the key. Multiple conditions go inside $and / $or arrays as separate sibling objects.',
      'Correct shape for a multi-condition $match: { "$match": { "$expr": { "$and": [ { "$gte": ["$date", {"$date":"2026-01-01T00:00:00Z"}] }, { "$eq": ["$isDeleted", false] }, { "$eq": ["$messageState", "done"] } ] } } }',
      'If the filter does NOT need to reference another field with `$`-prefixed paths, prefer the plain {"$match": { "isDeleted": false, "messageState": "done", "dCreateDate": { "$gte": …, "$lt": … } }} form — no `$expr` / `$and` needed, and the BSON Date comparison works directly on the indexed field.',
    );
  }
  if (hints.length === 0) return raw;
  return `${raw}\n\nAGENT HINTS:\n- ${hints.join('\n- ')}`;
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
  // Wrap the rest of the handler so any uncaught exception (LLM config
  // error, mongo connection failure, schema-load crash, ...) becomes a
  // structured JSON response. The agentic client parses every response
  // as JSON, so an HTML 500 page bubbles up as a cryptic "Unexpected
  // token '<'" error and the user can't recover.
  try {
    return await handleAgenticPost(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      error: 'internal',
      message: 'Agentic turn failed unexpectedly. Try again, or rephrase the question. ' +
        '(Server detail: ' + msg.slice(0, 300) + ')',
    }, { status: 500 });
  }
}

async function handleAgenticPost(req: Request): Promise<Response> {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // Surface the first failing path so the client can show a useful hint
    // instead of an opaque "invalid_body".
    const issue = parsed.error.issues[0];
    return NextResponse.json({
      error: 'invalid_body',
      message: issue ? `${issue.path.join('.')}: ${issue.message}` : 'request payload failed validation',
      issues: parsed.error.issues.slice(0, 5),
    }, { status: 400 });
  }

  const { history, lastReport, execute = true, maxRepairs = 2 } = parsed.data;
  // Drop empty/whitespace-only entries before the LLM sees them. Pure-report
  // assistant turns previously persisted with content='' on the client; those
  // shouldn't count as conversation. After filtering we must still have a
  // user turn to act on, otherwise there's nothing to answer.
  const cleaned = history.filter(m => m.content.trim().length > 0);
  if (cleaned.length === 0 || !cleaned.some(m => m.role === 'user')) {
    return NextResponse.json({
      error: 'invalid_body',
      message: 'history must contain at least one non-empty user message',
    }, { status: 400 });
  }
  const [digest, serverInfo] = await Promise.all([getSchema(false), getServerInfo()]);
  const version: [number, number] = [serverInfo.major, serverInfo.minor];
  // Sliding window: drop everything but the most recent N turns. The LLM
  // doesn't need ancient context, and trimming here keeps the prompt small
  // even when the client forgets to do so.
  const trimmed = cleaned.length > HISTORY_WINDOW ? cleaned.slice(-HISTORY_WINDOW) : cleaned;
  const history2: ChatMessage[] = trimmed.map(m => ({ role: m.role, content: m.content }));
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
      // Forward the structured "needs" hint so the client can render
      // an inline picker (e.g. Jalali date picker) for date questions.
      needs: first.needs ?? null,
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
    const errMsg = enrichError(current.execution.error ?? 'unknown_error', current.report);
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
        needs: next.needs ?? null,
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
