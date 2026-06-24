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
// A verification verdict tells the repair loop whether a SUCCESSFUL execution
// produced a row set that actually answers the question. Mongo accepting the
// pipeline is necessary but not sufficient: the LSH-style "field declared in
// $project but missing from every row" trap, all-null computed columns, and
// leaked EJSON wrappers all look fine to the driver and still represent a
// bogus answer.
type Verdict = { ok: true } | { ok: false, issue: string };
interface Attempt {
  source: 'initial' | 'repair';
  message: string;
  report: LlmReport;
  execution: Execution;
  // Present only on attempts where execution succeeded but verification
  // flagged a semantic problem. The string is fed to the next repair turn
  // as pendingError and surfaced as a warning on the final response if it
  // survives all repairs.
  verification?: Verdict;
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

// Read the keys declared in the FINAL row-shaping stage of a pipeline so
// the verifier can flag fields that the analyst asked for but that never
// appear in any output row (the LSH "bare scalar in $project becomes an
// inclusion flag" trap, $cond branches that all evaluate to undefined,
// typos in field paths inside expressions, etc.). Returns null when the
// pipeline doesn't end in a stage we can introspect (e.g. ends in $count).
function expectedOutputFields(pipeline: Record<string, unknown>[]): string[] | null {
  for (let i = pipeline.length - 1; i >= 0; i--) {
    const stage = pipeline[i];
    if (!stage || typeof stage !== 'object') continue;
    const stageKey = Object.keys(stage)[0];
    // $limit / $skip / $sort don't change the shape, keep walking back.
    if (stageKey === '$limit' || stageKey === '$skip' || stageKey === '$sort' || stageKey === '$unwind') continue;
    if (stageKey === '$project' || stageKey === '$addFields' || stageKey === '$set') {
      const spec = (stage as Record<string, unknown>)[stageKey] as Record<string, unknown>;
      if (!spec || typeof spec !== 'object') return null;
      const out: string[] = [];
      for (const [k, v] of Object.entries(spec)) {
        // Skip _id when explicitly excluded.
        if (k === '_id' && (v === 0 || v === false)) continue;
        // Skip pure exclusions in $project.
        if (stageKey === '$project' && (v === 0 || v === false)) continue;
        out.push(k);
      }
      return out;
    }
    if (stageKey === '$group') {
      const spec = (stage as Record<string, unknown>).$group as Record<string, unknown>;
      if (!spec || typeof spec !== 'object') return null;
      return Object.keys(spec);
    }
    // $replaceRoot / $replaceWith / $facet / $bucket reshape rows in ways
    // we can't statically introspect — skip verification rather than
    // false-positive.
    return null;
  }
  return null;
}

// Walk rows in the keys derived above and find those that are NULL or
// undefined in EVERY sampled row. A field declared in $project that's null
// everywhere is almost always a bug (wrong field path inside an expression,
// type mismatch in $multiply / $add, $lookup that joined zero matches with
// preserveNullAndEmptyArrays). One null among many isn't a problem; ALL
// null is.
function allNullColumns(rows: Record<string, unknown>[], keys: string[]): string[] {
  if (rows.length === 0) return [];
  return keys.filter(k => rows.every(r => r[k] === null || r[k] === undefined));
}

// Detect EJSON wrappers that leaked into row VALUES (not pipeline source).
// If we see {$oid:"..."} or {$date:"..."} inside a row, that means the
// pipeline returned a sub-document where a real BSON value was expected —
// usually a $literal-wrapped shorthand or a stored field that holds the
// shorthand as data. Surface it so the agent can fix the projection.
function findLeakedEjsonWrappers(rows: Record<string, unknown>[]): string[] {
  const found = new Set<string>();
  const wrapperKeys = new Set(['$oid', '$date', '$numberLong', '$numberInt', '$numberDouble', '$numberDecimal']);
  const visit = (v: unknown, path: string): void => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.slice(0, 5).forEach((x, i) => visit(x, `${path}[${i}]`)); return; }
    const o = v as Record<string, unknown>;
    const ks = Object.keys(o);
    if (ks.length === 1 && wrapperKeys.has(ks[0])) { found.add(`${path} = {${ks[0]}: ...}`); return; }
    for (const [k, val] of Object.entries(o)) visit(val, path ? `${path}.${k}` : k);
  };
  for (const row of rows.slice(0, 5)) for (const [k, v] of Object.entries(row)) visit(v, k);
  return [...found];
}

// Post-execution verification. Runs only when Mongo accepted the pipeline
// and returned rows; flags semantic problems that look fine to the driver
// but represent a wrong answer. Conservative on purpose — false positives
// would cause repair churn and waste the LLM call budget — so we only
// flag patterns with very low false-positive rates.
function verifyResult(report: LlmReport, execution: Execution): Verdict {
  if (!execution.ok || !execution.rows) return { ok: true };
  const rows = execution.rows;
  const issues: string[] = [];

  // Bug class 1: fields declared in the final row-shaping stage that never
  // materialise in output. The LSH problem and its cousins.
  const expected = expectedOutputFields(report.pipeline);
  if (expected && expected.length > 0 && rows.length > 0) {
    const sampleKeys = new Set<string>();
    for (const r of rows.slice(0, Math.min(rows.length, 5))) for (const k of Object.keys(r)) sampleKeys.add(k);
    const missing = expected.filter(f => !sampleKeys.has(f));
    if (missing.length > 0) {
      issues.push(
        `The final $project / $addFields / $group stage declared field(s) [${missing.join(', ')}] but they are ABSENT from every returned row. ` +
        `This usually means a bare scalar literal was treated as an inclusion flag (e.g. "x": 0.5 — wrap in {"$literal": 0.5}), a $cond / $switch branch evaluated to "remove this field", or a typo in a $-prefixed field path inside an expression.`,
      );
    }
  }

  // Bug class 2: computed columns that are null in EVERY row. Strong
  // signal of a type mismatch in $multiply / $divide / $subtract, a wrong
  // field path in $-paths, or a $lookup that joined zero documents on
  // every row with preserveNullAndEmptyArrays=true.
  if (expected && expected.length > 0 && rows.length >= 3) {
    const nullCols = allNullColumns(rows, expected);
    if (nullCols.length > 0) {
      issues.push(
        `Column(s) [${nullCols.join(', ')}] are NULL in every returned row. ` +
        `Check: (a) the operand field paths exist on the input documents (verify against the schema, not assumed names), ` +
        `(b) numeric operators ($multiply, $add, $divide) receive numeric operands — wrap stored string numbers with {"$toDouble": "$field"}, ` +
        `(c) a $lookup with preserveNullAndEmptyArrays=true returns null when no documents match — drop the preserve flag if the join is required, or use an existence filter.`,
      );
    }
  }

  // Bug class 3: EJSON shorthand wrappers leaking into row values. The
  // pipeline-guard auto-decodes them in pipeline definitions, but if the
  // pipeline itself OUTPUTS a wrapper (e.g. {$project: { foo: {$literal:
  // {$oid: "..."}}} }) the wrapper survives into rows and downstream
  // renderers can't interpret it.
  const leaks = findLeakedEjsonWrappers(rows);
  if (leaks.length > 0) {
    issues.push(
      `Output rows contain EJSON shorthand wrappers as VALUES: ${leaks.slice(0, 5).join('; ')}. ` +
      `A $project / $addFields expression returned a sub-document like {"$oid": "..."} or {"$date": "..."} instead of a real BSON value. ` +
      `Drop the wrapper: emit the bare 24-hex string (for ObjectIds rendered as identifiers) or use {"$toString": "$field"} for explicit string coercion.`,
    );
  }

  if (issues.length === 0) return { ok: true };
  return {
    ok: false,
    issue:
      'Pipeline executed without error but the result set is suspect:\n- ' +
      issues.join('\n- ') +
      '\n\nProduce a corrected pipeline. The execution layer will not display this result; re-run after fixing.',
  };
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
  // EJSON shorthand ({"$oid":"..."}, {"$numberLong":"..."}, {"$date":"..."})
  // landing inside an expression operator ($eq / $cond / $addFields / $project
  // computed) makes the server try to dispatch the shorthand key as an
  // expression operator and fail with "Unrecognized expression '$xxx'". The
  // pipeline-guard auto-decodes these literals before execution, so reaching
  // this branch means a typo (e.g. 23-char hex, missing quotes, $-prefixed
  // key inside a field-path expression) survived the rewrite.
  if (
    /unrecognized expression '\$(oid|date|numberlong|numberint|numberdouble|numberdecimal)'/.test(lower) ||
    lower.includes("unrecognized expression '$oid'") ||
    lower.includes("unrecognized expression '$date'")
  ) {
    hints.push(
      'A BSON shorthand literal landed inside an aggregation expression and the server tried to evaluate the wrapper key (e.g. "$oid") as an operator. The server-side pipeline-guard already rewrites well-formed {"$oid":"<24hex>"} / {"$date":"<ISO>"} literals into real BSON values — so the failing literal is malformed: either the hex string is not exactly 24 lowercase characters, the date is not a full ISO timestamp with Z, or the shorthand was nested inside a $literal / quoted as a string.',
      'Fix: for ObjectId comparisons emit a bare {"$oid":"<24-hex-lowercase>"} value. To compare an _id field against an ObjectId literal inside $expr / $cond use {"$eq": ["$_id", {"$oid": "5e56456cf900052ed23d692b"}]} — never wrap the {$oid:...} in $literal, never quote it as a JSON string.',
      'If you need to compare against a STRING value that happens to look like a 24-hex ObjectId (e.g. a stored hex string in a non-_id field), use a plain JSON string literal "5e56…692b" instead of the $oid wrapper.',
    );
  }
  // The "$expr" / $cond / $addFields ObjectId comparison anti-pattern: the
  // model compared an _id (BSON ObjectId) against a bare 24-hex JSON string.
  // MongoDB type bracketing makes that silently match nothing, so the user
  // sees "0 rows" even though the syntax was accepted.
  if (
    lower.includes('returned 0 rows') ||
    lower.includes('zero rows') ||
    lower.includes('no documents matched')
  ) {
    const pipelineJson = JSON.stringify(broken.pipeline);
    if (/"\$eq":\s*\[\s*"\$[a-zA-Z_.]+_id"?,\s*"[a-f0-9]{24}"/i.test(pipelineJson)) {
      hints.push(
        'A $eq comparison on an _id-typed field used a bare hex STRING literal, which never matches an ObjectId field under BSON type bracketing. Wrap the hex value in {"$oid": "<hex>"} so the driver sends a real ObjectId.',
      );
    }
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
  const initialVerdict = verifyResult(initial.sealed, initial.execution);
  const attempts: Attempt[] = [{
    source: 'initial',
    message: first.message,
    report: initial.sealed,
    execution: initial.execution,
    verification: initialVerdict.ok ? undefined : initialVerdict,
  }];

  // --- Self-repair loop -----------------------------------------------------
  // Trigger the repair turn when EITHER the driver rejected the pipeline
  // (execution.ok=false) OR the verification layer flagged a semantically
  // bogus result (missing projected columns, all-null computed columns,
  // EJSON wrappers leaking into output). Bounded by maxRepairs so we
  // never spin; verification failures consume the same budget as Mongo
  // failures by design.
  let current = attempts[0];
  const needsRepair = (a: Attempt) => !a.execution.ok || (a.verification !== undefined && !a.verification.ok);
  for (let i = 0; i < maxRepairs && needsRepair(current); i++) {
    // Choose the most actionable pendingError: a Mongo error is always
    // more specific than a verification verdict, so prefer that when
    // both could apply (though they're mutually exclusive in practice
    // because verification only runs on execution.ok=true).
    const pendingError = !current.execution.ok
      ? enrichError(current.execution.error ?? 'unknown_error', current.report)
      : (current.verification && !current.verification.ok ? current.verification.issue : 'unknown_error');
    const next = await callAgent(history2, current.report, pendingError, digest, serverInfo);
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
    const verdict = verifyResult(ran.sealed, ran.execution);
    current = {
      source: 'repair',
      message: next.message,
      report: ran.sealed,
      execution: ran.execution,
      verification: verdict.ok ? undefined : verdict,
    };
    attempts.push(current);
    if (!needsRepair(current)) break;
  }

  const final = attempts[attempts.length - 1];
  // If verification still flags the final attempt after the repair budget
  // is exhausted, append a clear warning to the report so the analyst
  // knows the result is suspect and the displayed table may be missing
  // columns or contain bogus null values. We surface this both inside
  // report.warnings (which the table header chip already renders) and as
  // a top-level verification.issue so client-side panels can highlight
  // it more prominently.
  const finalVerdict: Verdict | undefined = final.verification;
  let finalReport = final.report;
  if (finalVerdict && !finalVerdict.ok) {
    const existing = Array.isArray(final.report.warnings) ? final.report.warnings : [];
    finalReport = {
      ...final.report,
      warnings: [
        ...existing,
        'Self-verification flagged this result as suspect after exhausting the repair budget. ' +
        'Inspect carefully: ' + finalVerdict.issue.split('\n')[0],
      ],
    };
  }
  return NextResponse.json({
    kind: 'report',
    message: final.message,
    report: finalReport,
    execution: final.execution,
    verification: finalVerdict && !finalVerdict.ok ? { ok: false, issue: finalVerdict.issue } : { ok: true },
    // Repair attempts in chronological order, excluding the initial turn.
    repairs: attempts.slice(1).map(a => ({
      message: a.message,
      report: a.report,
      execution: a.execution,
      verification: a.verification ?? { ok: true },
    })),
  });
}
