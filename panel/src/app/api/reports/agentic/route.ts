import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Db, ObjectId } from 'mongodb';
import { requireRole } from '@/lib/auth';
import { getSchema, type SchemaDigest } from '@/lib/schema';
import { agenticReport, isLlmOutputError, type ChatMessage, type LlmReport, type AgenticTurn } from '@/lib/llm';
import { validatePipeline, lowerPipeline } from '@/lib/pipeline-guard';
import {
  diffPipelines, classifyRefinementIntent, isOverbroadEdit, summariseDiff,
} from '@/lib/pipeline-diff';
import { checkLogicalConsistency } from '@/lib/pipeline-logic';
import { dataDb, biDb, getServerInfo } from '@/lib/mongo';
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
  // When the client has a persisted conversation, it sends the id so the
  // server can append a version snapshot to the conversation doc after a
  // successful report turn. Optional: ad-hoc / unsaved runs (no id yet)
  // simply skip the version write \u2014 the chat still works end-to-end.
  conversationId: z.string().optional(),
  // The version this turn is refining FROM. Lets the server record the
  // tree edge between the new snapshot and the snapshot the user was
  // viewing when they typed their message. Defaults to the tip of the
  // versions array when omitted (legacy clients) so existing chats keep
  // building a linear trunk.
  parentVersionId: z.string().optional(),
});

// Cap the embedded versions array so a long-lived conversation can't grow
// the doc indefinitely. 50 snapshots is enough for any realistic refining
// session; older versions are dropped from the head when the cap is hit.
const MAX_VERSIONS_PER_CONVERSATION = 50;

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

// Pre-execution logical consistency check. Returns either the (possibly
// autofixed) report so execution can proceed, or a 'clarify' verdict so the
// route can either feed it back into self-repair or surface a friendly
// question. Stays out of the Mongo round-trip path so we never execute a
// pipeline we already know is logically broken.
type PrecheckResult =
  | { kind: 'ok'; report: LlmReport }
  | { kind: 'clarify'; issue: string; question: string; rule: string };
function precheckLogic(report: LlmReport): PrecheckResult {
  const verdict = checkLogicalConsistency(report.pipeline);
  if (verdict.ok) return { kind: 'ok', report };
  if (verdict.mode === 'autofix') {
    const warnings = [...(report.warnings ?? []), verdict.warning];
    return { kind: 'ok', report: { ...report, pipeline: verdict.pipeline, warnings } };
  }
  return { kind: 'clarify', issue: verdict.issue, question: verdict.question, rule: verdict.rule };
}

// Validate + execute a single report. Returns the sealed report (with the
// pipeline as the guard returned it) and an Execution result. Never throws
// — Mongo errors become { ok:false, error }.
//
// IMPORTANT: the sealed pipeline is the POST-VALIDATION, PRE-LOWERING form
// — i.e. EJSON shorthand wrappers like {"$oid":"..."} and {"$date":"..."}
// are preserved. Lowering produces real BSON ObjectId / Date instances that
// JSON.stringify (called by NextResponse.json) reduces to bare hex / ISO
// strings, which would erase the corrections the autofix pass made (e.g.
// {"$oid":"<hex>"} → "<hex>") and ship the buggy form back to the client.
// Templates, version snapshots, and the next turn's `lastReport` echo all
// derive from sealed.pipeline, so they MUST carry the corrected EJSON form.
// The lowered tree is used ONLY for the Mongo driver call inside this
// function and is intentionally not exposed past the driver boundary.
async function runReport(db: Db, report: LlmReport, version: [number, number]): Promise<{ sealed: LlmReport; execution: Execution }> {
  let validated;
  try { validated = validatePipeline({ collection: report.collection, pipeline: report.pipeline }); }
  catch (e) {
    return {
      sealed: report,
      execution: { ok: false, error: 'invalid_pipeline: ' + (e instanceof Error ? e.message : String(e)) },
    };
  }
  const sealed: LlmReport = { ...report, collection: validated.collection, pipeline: validated.pipeline };
  // Rewrite modern date-math operators into literals for older servers and
  // decode EJSON shorthand into real BSON values for the driver. Surfaces a
  // clear error back to the self-repair loop when something genuinely can't
  // be lowered. The lowered tree is local to this call site.
  let lowered: Record<string, unknown>[];
  try { lowered = lowerPipeline(validated.pipeline, version); }
  catch (e) {
    return {
      sealed,
      execution: { ok: false, error: 'unsupported_operator: ' + (e instanceof Error ? e.message : String(e)) },
    };
  }
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

// Discriminated union the route uses to decide what to do next.
// - 'ok': the LLM returned a parseable, well-shaped turn.
// - 'malformed_output': the LLM emitted JSON we can't decode or whose shape
//   doesn't satisfy the report contract. RECOVERABLE \u2014 the route feeds a
//   strict-reformat instruction into the next pendingError and tries again.
// - 'transport': anything else (network, auth, schema-build, mongo digest
//   fetch). The route treats this as recoverable too \u2014 it surfaces a
//   conversational fallback instead of HTTP 5xx.
type AgentResult =
  | { status: 'ok'; turn: AgenticTurn }
  | { status: 'malformed_output'; detail: string }
  | { status: 'transport'; detail: string };
async function callAgent(
  history: ChatMessage[], lastReport: LlmReport | null, pendingError: string | null,
  digest: SchemaDigest, serverVersion: { major: number; minor: number; raw: string },
  reqId: string,
): Promise<AgentResult> {
  try {
    const turn = await agenticReport({ history, lastReport, pendingError, serverVersion }, digest);
    return { status: 'ok', turn };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (isLlmOutputError(e)) {
      console.warn(`[agentic ${reqId}] malformed LLM output:`, detail, e instanceof Error && 'snippet' in e ? (e as { snippet?: string }).snippet : undefined);
      return { status: 'malformed_output', detail };
    }
    console.warn(`[agentic ${reqId}] transport / config failure:`, detail);
    return { status: 'transport', detail };
  }
}

// Internal instruction we feed back to the model when its OWN output failed
// to decode. This is never shown to the user; it lives only inside the next
// pendingError sent to the LLM.
function strictReformatInstruction(detail: string): string {
  return [
    'Your previous response could not be parsed by the server.',
    'Internal decode detail (do NOT echo to the user): ' + detail,
    'Re-emit a SINGLE strict JSON object that satisfies the response schema:',
    '  - kind is "question" or "report"',
    '  - message is a short plain-language string for the user',
    '  - when kind="report", the embedded pipeline field MUST be a JSON-encoded string of an ARRAY of stage objects (e.g. "[{\\"$match\\":...}]"). Every key and string MUST be double-quoted. No trailing commas. No comments. No ellipses. No control characters inside string literals.',
    '  - Keep the pipeline focused and short. If the previous output was likely truncated, drop optional fields (warnings, unused $project keys) to stay under the output cap.',
  ].join('\n');
}

// Detect whether the most recent user turn was written in Persian/Farsi so
// the conversational fallback message lands in the right language. We rely
// on Unicode block U+0600-06FF which covers Arabic/Persian script.
function userLanguage(history: ChatMessage[]): 'fa' | 'en' {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      // eslint-disable-next-line no-misleading-character-class
      return /[\u0600-\u06FF]/.test(history[i].content) ? 'fa' : 'en';
    }
  }
  return 'en';
}

// Conversational fallback messages used when self-healing has exhausted its
// budget. The user never sees a stack trace or parser error; they see a
// short, collaborative prompt that invites them to refine the request.
type FallbackKind = 'malformed_output' | 'transport' | 'mongo_unrecoverable' | 'verification_unrecoverable';
function fallbackMessage(kind: FallbackKind, lang: 'fa' | 'en'): string {
  if (lang === 'fa') {
    switch (kind) {
      case 'malformed_output':
        return 'یک لحظه گیر کردم و نتوانستم پاسخ قبلی را کامل بسازم. می‌توانیم تغییر آخر را کمی ساده‌تر یا قدم‌به‌قدم بگوییم؟ یا اگر مایلید، به نسخهٔ قبلی برمی‌گردیم و از آنجا ادامه می‌دهیم.';
      case 'transport':
        return 'فعلاً نمی‌توانم به سرویس فکر متصل بمانم. لطفاً همان درخواست را یک‌بار دیگر بفرستید؛ اگر باز هم نشد، بفرمایید چه چیزی را می‌خواهید ببینید تا با مسیر دیگری امتحان کنم.';
      case 'mongo_unrecoverable':
        return 'بعد از چند تلاش هنوز نتوانستم این درخواست را اجرا کنم. می‌توانیم: ۱) فیلد یا فیلتر مشخصی که مدنظرتان است را تأیید کنیم، ۲) به نسخهٔ قبلی همین گفت‌وگو برگردیم، یا ۳) درخواست را به بخش‌های کوچک‌تر بشکنیم. کدام را ترجیح می‌دهید؟';
      case 'verification_unrecoverable':
        return 'نتیجه‌ای که آماده شد به نظر کامل نمی‌رسد و نمی‌خواهم چیز اشتباهی نشان دهم. لطفاً بفرمایید کدام ستون‌ها برایتان مهم‌تر است یا اگر مایلید نسخهٔ قبلی را بازیابی کنیم.';
    }
  }
  switch (kind) {
    case 'malformed_output':
      return 'I lost the thread while finalizing that change. Could we tackle the last step more simply — for example one tweak at a time — or would you like me to roll back to the previous version and try a different path?';
    case 'transport':
      return 'I temporarily can\'t reach my reasoning service. Please resend the same request; if it still doesn\'t go through, tell me what you need to see and I\'ll try a different approach.';
    case 'mongo_unrecoverable':
      return 'After a few tries I still couldn\'t run that query cleanly. We can: (1) confirm the exact field or filter you have in mind, (2) restore the previous version and continue from there, or (3) break the request into smaller steps. Which would you prefer?';
    case 'verification_unrecoverable':
      return 'The result didn\'t look complete enough to show \u2014 I\'d rather not display something misleading. Could you tell me which columns matter most, or shall I restore the previous version?';
  }
}

// User-facing label for an execution that failed under the hood. We never
// echo the raw Mongo / driver message: it's noise for the analyst and a
// liability for the assistant persona. The detailed text stays in server
// logs and in the persisted ConversationVersion (developer artifact).
function publicExecutionLabel(_raw: string | undefined, lang: 'fa' | 'en'): string {
  return lang === 'fa' ? 'این مرحله نیاز به اصلاح داشت' : 'Needed an adjustment';
}

export async function POST(req: Request) {
  let me; try { me = await requireRole('admin', 'analyst'); } catch (r) { return r as Response; }
  // The agentic handler is recovery-first: any path that previously could
  // throw a raw exception now lands on a conversational kind:'question'
  // turn. This wrapper is a final safety net for the truly unexpected
  // (handler crash before it builds a response) \u2014 we still hand back a
  // friendly turn instead of HTTP 5xx with a stack trace, and log the raw
  // detail to the server console for developer observability.
  const reqId = new ObjectId().toHexString().slice(-8);
  try {
    return await handleAgenticPost(req, me.sub, reqId);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[agentic ${reqId}] uncaught handler failure:`, detail, e instanceof Error ? e.stack : undefined);
    // Best-effort language detection from the body we already consumed isn't
    // possible here (the request body was consumed inside handleAgenticPost).
    // Default to English; the conversational turn is generic enough that an
    // analyst can recover from either side.
    return NextResponse.json({
      kind: 'question',
      message: fallbackMessage('transport', 'en'),
      needs: null,
      repairs: [],
    });
  }
}

// A version snapshot persisted into agentic_conversations.versions on every
// successful report turn. Captures the full generated query plus the
// execution / verification verdict so analysts can review prior pipelines,
// compare diffs, and restore an earlier version into the active report pane
// without having to replay the chat.
interface ConversationVersion {
  id: string;
  createdAt: Date;
  // 'initial' = first report this turn produced.
  // 'repair'  = a self-repair attempt succeeded after one or more failures.
  source: 'initial' | 'repair';
  collection: string;
  pipeline: Record<string, unknown>[];
  display: LlmReport['display'];
  explanation: string;
  warnings: string[];
  // Lightweight execution stats only \u2014 rows are NOT persisted (bulky,
  // stale fast, and the analyst can re-execute the pipeline if needed).
  execution: {
    ok: boolean;
    count?: number;
    took?: number;
    truncated?: boolean;
    error?: string;
  };
  // Present only when the post-execution verifier flagged the result.
  verification?: { ok: false; issue: string };
  // First ~200 chars of the user message that triggered this version,
  // so the versions list is readable without expanding every entry.
  triggerMessage: string;
  // Number of repair attempts the loop took before this version was
  // produced. 0 for a clean first-try report.
  repairCount: number;
  // Tree-versioning fields. parentVersionId points at the version this
  // turn was refined FROM (null for the first version of a conversation).
  // It enables a tree UI where branching from a restored snapshot creates
  // a sibling rather than overwriting the linear history. summary is a
  // short human-readable stage diff vs the parent (cached at write time
  // so the versions panel can render a tree without re-diffing on render).
  parentVersionId: string | null;
  diffSummary: string | null;
}

// Resolve the version this turn descends from. When the caller passed an
// explicit parentVersionId, we look it up by id; otherwise we return the
// tip of the versions array (newest entry). Returns null when no parent
// exists \u2014 the first version of a conversation, or a conversation that
// hasn't persisted any versions yet. Resilient to Mongo errors: a failed
// read yields null so the write still proceeds as an orphan root.
async function resolveParentVersion(
  conversationId: string, userId: string, explicitId: string | null,
): Promise<ConversationVersion | null> {
  if (!ObjectId.isValid(conversationId)) return null;
  try {
    const db = await biDb();
    const doc = await db.collection<{ versions?: ConversationVersion[] }>('agentic_conversations').findOne(
      { _id: new ObjectId(conversationId), userId },
      { projection: { versions: 1 } },
    );
    const versions = doc?.versions ?? [];
    if (versions.length === 0) return null;
    if (explicitId) {
      const found = versions.find(x => x.id === explicitId);
      if (found) return found;
    }
    return versions[versions.length - 1];
  } catch {
    return null;
  }
}

async function appendConversationVersion(
  conversationId: string, userId: string, v: ConversationVersion,
): Promise<boolean> {
  if (!ObjectId.isValid(conversationId)) return false;
  try {
    const db = await biDb();
    const r = await db.collection('agentic_conversations').updateOne(
      { _id: new ObjectId(conversationId), userId },
      {
        // $slice with a negative N keeps the most-recent N entries, dropping
        // older ones from the head of the array. We $push first, then trim,
        // atomically.
        $push: { versions: { $each: [v], $slice: -MAX_VERSIONS_PER_CONVERSATION } },
        $set: { updatedAt: new Date() },
      // The $push + $slice combo isn't expressible in the strict TS types
      // the driver ships, but the BSON server understands it natively.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    );
    return r.matchedCount > 0;
  } catch {
    // Version write is best-effort: never fail the agentic turn because
    // persistence hit a transient Mongo error.
    return false;
  }
}

async function handleAgenticPost(req: Request, userId: string, reqId: string): Promise<Response> {
  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    // A body validation failure is almost always a client bug, not a user
    // mistake. We log the detail for developers and respond with the same
    // conversational fallback as any other unrecoverable internal issue so
    // the user is not exposed to zod messages or path traversal noise.
    console.warn(`[agentic ${reqId}] invalid request body:`, parsed.error.issues.slice(0, 5));
    // Heuristic language: try to read history from the raw body even though
    // it failed validation; default to English on failure.
    const probe: ChatMessage[] = Array.isArray((body as { history?: unknown })?.history)
      ? ((body as { history: unknown[] }).history.filter(
          (m): m is ChatMessage => !!m && typeof m === 'object'
            && typeof (m as { content?: unknown }).content === 'string',
        ))
      : [];
    return NextResponse.json({
      kind: 'question',
      message: fallbackMessage('transport', userLanguage(probe)),
      needs: null,
      repairs: [],
    });
  }

  const { history, lastReport, execute = true, maxRepairs = 2, conversationId, parentVersionId } = parsed.data;
  // Drop empty/whitespace-only entries before the LLM sees them. Pure-report
  // assistant turns previously persisted with content='' on the client; those
  // shouldn't count as conversation. After filtering we must still have a
  // user turn to act on, otherwise there's nothing to answer.
  const cleaned = history.filter(m => m.content.trim().length > 0);
  if (cleaned.length === 0 || !cleaned.some(m => m.role === 'user')) {
    console.warn(`[agentic ${reqId}] empty history after cleaning`);
    return NextResponse.json({
      kind: 'question',
      message: fallbackMessage('transport', userLanguage(history as ChatMessage[])),
      needs: null,
      repairs: [],
    });
  }
  const lang = userLanguage(cleaned as ChatMessage[]);
  const [digest, serverInfo] = await Promise.all([getSchema(false), getServerInfo()]);
  const version: [number, number] = [serverInfo.major, serverInfo.minor];
  // Sliding window: drop everything but the most recent N turns. The LLM
  // doesn't need ancient context, and trimming here keeps the prompt small
  // even when the client forgets to do so.
  const trimmed = cleaned.length > HISTORY_WINDOW ? cleaned.slice(-HISTORY_WINDOW) : cleaned;
  const history2: ChatMessage[] = trimmed.map(m => ({ role: m.role, content: m.content }));
  const db = await dataDb();

  // Generation budget: every LLM call \u2014 initial OR repair OR strict-reformat
  // retry \u2014 draws from this shared counter so a chatty model can't burn the
  // budget on malformed-output retries alone. maxRepairs+1 keeps the same
  // total spend as before (1 initial + N repairs), but now any of those
  // slots can be consumed by an output-shape retry instead.
  let llmBudget = maxRepairs + 1;
  const callWithBudget = async (
    h: ChatMessage[], lastR: LlmReport | null, pendingError: string | null,
  ): Promise<AgentResult> => {
    if (llmBudget <= 0) return { status: 'transport', detail: 'llm_budget_exhausted' };
    llmBudget -= 1;
    return callAgent(h, lastR, pendingError, digest, serverInfo, reqId);
  };

  // --- Initial turn with strict-reformat self-healing ----------------------
  // If the model returns malformed JSON / wrong shape, we re-ask up to the
  // remaining budget with an internal "re-emit strict JSON" instruction.
  // The retries never reach the user.
  let firstTurn: AgenticTurn | null = null;
  let firstFailure: AgentResult | null = null;
  {
    let pending: string | null = null;
    while (firstTurn === null) {
      const r = await callWithBudget(history2, lastReport ?? null, pending);
      if (r.status === 'ok') { firstTurn = r.turn; break; }
      if (r.status === 'malformed_output' && llmBudget > 0) {
        pending = strictReformatInstruction(r.detail);
        continue;
      }
      firstFailure = r;
      break;
    }
  }
  if (!firstTurn) {
    // Self-healing exhausted on the very first turn \u2014 convert to a friendly
    // question so the analyst can rephrase or simplify.
    const kind: FallbackKind = firstFailure?.status === 'transport' ? 'transport' : 'malformed_output';
    return NextResponse.json({
      kind: 'question',
      message: fallbackMessage(kind, lang),
      needs: null,
      repairs: [],
    });
  }
  const firstNormalized = normalizeReport(firstTurn);
  if (!firstNormalized) {
    // The agent itself elected to ask a clarifying question \u2014 this is the
    // intended conversational path, not a failure. Pass the message through.
    return NextResponse.json({
      kind: 'question',
      message: firstTurn.message || (lang === 'fa'
        ? 'برای ادامه چند اطلاع بیشتر لازم دارم — مجموعه و بازهٔ زمانی مدنظر شما کدام است؟'
        : 'I need a little more detail to continue — which collection and time range did you have in mind?'),
      needs: firstTurn.needs ?? null,
    });
  }
  // --- Partial-Modification guard ------------------------------------------
  // When the user phrased a LOCAL refinement (rename / filter / sort / chart
  // / threshold) but the LLM produced a structurally wide rewrite (anchor
  // changed, $lookup graph shifted, half the stages churned), give the model
  // exactly ONE budget slot to re-emit a preserving version. Failing that we
  // surface a friendly clarification turn so the user can confirm intent
  // instead of silently shipping a regenerated pipeline. Skipped on first
  // turns (no lastReport) and on structural / ambiguous refinements.
  let refinedFirst = firstNormalized;
  if (lastReport) {
    const lastUserMsg = [...trimmed].reverse().find(m => m.role === 'user')?.content ?? '';
    const intent = classifyRefinementIntent(lastUserMsg);
    if (intent === 'local') {
      const diff = diffPipelines(
        lastReport.collection, lastReport.pipeline as Record<string, unknown>[],
        refinedFirst.collection, refinedFirst.pipeline,
      );
      if (isOverbroadEdit(intent, diff)) {
        console.warn(`[agentic ${reqId}] preservation guard: overbroad edit on local refinement -> ${summariseDiff(diff)}`);
        if (llmBudget > 0) {
          const reEmit = await callWithBudget(
            history2, lastReport,
            'PRESERVATION_VIOLATION: the previous pipeline executed successfully. The user\u2019s last message is a LOCAL refinement (a single localised change). Your draft response changed too much (' + summariseDiff(diff) + '). Re-emit a CORRECTED full report that copies the previous pipeline verbatim and applies ONLY the smallest change required to satisfy the user\u2019s instruction. Do not reorder stages, do not rename aliases, do not swap operators that already worked. Stages and clauses unrelated to the user\u2019s request must be byte-identical to the previous pipeline.',
          );
          if (reEmit.status === 'ok') {
            const renorm = normalizeReport(reEmit.turn);
            if (renorm) {
              const recheck = diffPipelines(
                lastReport.collection, lastReport.pipeline as Record<string, unknown>[],
                renorm.collection, renorm.pipeline,
              );
              if (!isOverbroadEdit(intent, recheck)) {
                refinedFirst = renorm;
                firstTurn = { ...firstTurn, message: reEmit.turn.message || firstTurn.message };
              } else {
                // Still overbroad after one re-emit. Escalate as a friendly
                // clarification rather than executing a likely-wrong rewrite.
                return NextResponse.json({
                  kind: 'question',
                  message: lang === 'fa'
                    ? `برای اعمال این تغییر، بخش‌های دیگر گزارش هم تغییر می‌کنند (${summariseDiff(recheck)}). آیا می‌خواهید همان ساختار قبلی حفظ شود و فقط همان مورد خواسته‌شده اصلاح شود، یا گزارش از نو ساخته شود؟`
                    : `Applying this change would also affect ${summariseDiff(recheck)} of the previous report. Should I keep the previous structure and apply only the specific change you asked for, or rebuild the report from scratch?`,
                  needs: null,
                  repairs: [],
                });
              }
            }
          }
        }
      }
    }
  }

  if (!execute) {
    return NextResponse.json({ kind: 'report', message: firstTurn.message, report: refinedFirst, execution: null, repairs: [] });
  }

  // --- Pre-execution logical consistency check -----------------------------
  // Catches condition-level bugs (contradictory $match clauses, $limit
  // before $sort, $match on removed fields, ...) BEFORE we pay the Mongo
  // round-trip. Autofix verdicts are applied silently with a warning;
  // clarify verdicts get one budgeted repair attempt, then escalate to a
  // friendly question instead of executing a pipeline we know is broken.
  let precheck = precheckLogic(refinedFirst);
  while (precheck.kind === 'clarify' && llmBudget > 0) {
    console.warn(`[agentic ${reqId}] logic precheck (${precheck.rule}): ${precheck.issue}`);
    const repair = await callWithBudget(
      history2, refinedFirst,
      `LOGICAL_INCONSISTENCY[${precheck.rule}]: ${precheck.issue} Re-emit the report with this condition resolved. Preserve every other stage byte-for-byte; only adjust the pieces directly involved in the conflict.`,
    );
    if (repair.status !== 'ok') break;
    const renorm = normalizeReport(repair.turn);
    if (!renorm) break;
    refinedFirst = renorm;
    firstTurn = { ...firstTurn, message: repair.turn.message || firstTurn.message };
    precheck = precheckLogic(refinedFirst);
  }
  if (precheck.kind === 'clarify') {
    return NextResponse.json({
      kind: 'question',
      message: lang === 'fa'
        ? `برای اجرای این گزارش یک ناسازگاری منطقی وجود دارد: ${precheck.question}`
        : precheck.question,
      needs: null,
      repairs: [],
    });
  }
  refinedFirst = precheck.report;

  const initial = await runReport(db, refinedFirst, version);
  if (!initial.execution.ok) {
    console.warn(`[agentic ${reqId}] initial execution failed:`, initial.execution.error);
  }
  const initialVerdict = verifyResult(initial.sealed, initial.execution);
  const attempts: Attempt[] = [{
    source: 'initial',
    message: firstTurn.message,
    report: initial.sealed,
    execution: initial.execution,
    verification: initialVerdict.ok ? undefined : initialVerdict,
  }];

  // --- Self-repair loop -----------------------------------------------------
  // Trigger the repair turn when EITHER the driver rejected the pipeline
  // (execution.ok=false) OR the verification layer flagged a semantically
  // bogus result. The same budget covers malformed-output retries during
  // repair, so a chronic JSON-shape regression can't starve actual fixes.
  let current = attempts[0];
  const needsRepair = (a: Attempt) => !a.execution.ok || (a.verification !== undefined && !a.verification.ok);
  while (needsRepair(current) && llmBudget > 0) {
    const pendingError = !current.execution.ok
      ? enrichError(current.execution.error ?? 'unknown_error', current.report)
      : (current.verification && !current.verification.ok ? current.verification.issue : 'unknown_error');
    let next = await callWithBudget(history2, current.report, pendingError);
    if (next.status === 'malformed_output') {
      // Try one more time with a strict-reformat instruction stacked on top
      // of the pending error so we keep the diagnostic context.
      if (llmBudget <= 0) break;
      next = await callWithBudget(
        history2, current.report,
        pendingError + '\n\n' + strictReformatInstruction(next.detail),
      );
    }
    if (next.status !== 'ok') break;
    const norm = normalizeReport(next.turn);
    if (!norm) {
      // The agent decided to ask a clarifying question instead of fixing.
      // That's a perfectly valid recovery path \u2014 hand it to the user.
      return NextResponse.json({
        kind: 'question',
        message: next.turn.message || (lang === 'fa'
          ? 'برای اصلاح این درخواست به یک نکتهٔ بیشتر نیاز دارم \u2014 می‌توانید کمی توضیح دهید؟'
          : 'I need one more detail to refine this \u2014 could you clarify?'),
        needs: next.turn.needs ?? null,
        repairs: sanitiseRepairs(attempts.slice(1), lang),
      });
    }
    // Re-run the logical consistency check on the repair attempt. Autofix
    // verdicts are applied transparently; clarify verdicts skip execution
    // and synthesise a failed attempt so the loop spends its next budget
    // slot fixing the logical conflict instead of the Mongo error.
    const repairCheck = precheckLogic(norm);
    if (repairCheck.kind === 'clarify') {
      console.warn(`[agentic ${reqId}] logic precheck on repair (${repairCheck.rule}): ${repairCheck.issue}`);
      current = {
        source: 'repair',
        message: next.turn.message,
        report: norm,
        execution: { ok: false, error: `logical_inconsistency[${repairCheck.rule}]: ${repairCheck.issue}` },
      };
      attempts.push(current);
      continue;
    }
    const ran = await runReport(db, repairCheck.report, version);
    if (!ran.execution.ok) {
      console.warn(`[agentic ${reqId}] repair execution failed:`, ran.execution.error);
    }
    const verdict = verifyResult(ran.sealed, ran.execution);
    current = {
      source: 'repair',
      message: next.turn.message,
      report: ran.sealed,
      execution: ran.execution,
      verification: verdict.ok ? undefined : verdict,
    };
    attempts.push(current);
    if (!needsRepair(current)) break;
  }

  const final = attempts[attempts.length - 1];
  // --- Unrecoverable outcomes \u2192 conversational fallback ------------------
  // If the repair budget is gone and the final attempt still has either a
  // Mongo failure or a flagged verification issue, we do NOT ship a broken
  // report to the user. Instead we return a kind:'question' turn with a
  // friendly recovery prompt. The analyst can rephrase, restore an earlier
  // version, or simplify the request \u2014 always staying inside the chat.
  if (!final.execution.ok) {
    return NextResponse.json({
      kind: 'question',
      message: fallbackMessage('mongo_unrecoverable', lang),
      needs: null,
      repairs: sanitiseRepairs(attempts.slice(1), lang),
    });
  }
  const finalVerdict: Verdict | undefined = final.verification;
  if (finalVerdict && !finalVerdict.ok) {
    return NextResponse.json({
      kind: 'question',
      message: fallbackMessage('verification_unrecoverable', lang),
      needs: null,
      repairs: sanitiseRepairs(attempts.slice(1), lang),
    });
  }

  const finalReport = final.report;
  // Persist a version snapshot when this turn produced a report and the
  // client supplied a conversation id. Best-effort \u2014 a Mongo blip never
  // fails the turn. The persisted snapshot is a developer-visible artifact
  // and may include the raw execution.error string for debugging.
  let savedVersion: ConversationVersion | null = null;
  if (conversationId && execute) {
    const lastUserMsg = [...trimmed].reverse().find(m => m.role === 'user')?.content ?? '';
    // Resolve the parent version. When the client supplied parentVersionId
    // we trust it (the user explicitly branched from a restored snapshot).
    // Otherwise we fall back to the current tip so a normal "send" extends
    // the trunk. Both lookups read existing versions from the doc; failure
    // simply yields null (orphan root).
    const parent = await resolveParentVersion(conversationId, userId, parentVersionId ?? null);
    const diffSummary = parent
      ? summariseDiff(diffPipelines(parent.collection, parent.pipeline, finalReport.collection, finalReport.pipeline))
      : null;
    const v: ConversationVersion = {
      id: new ObjectId().toHexString(),
      createdAt: new Date(),
      source: final.source,
      collection: finalReport.collection,
      pipeline: finalReport.pipeline,
      display: finalReport.display,
      explanation: finalReport.explanation,
      warnings: Array.isArray(finalReport.warnings) ? finalReport.warnings : [],
      execution: {
        ok: final.execution.ok,
        count: final.execution.count,
        took: final.execution.took,
        truncated: final.execution.truncated,
        error: final.execution.error,
      },
      // Reached this branch only when the verifier was happy with the result
      // (the !ok case returns a kind:'question' turn higher up). No issue
      // field to record.
      verification: undefined,
      triggerMessage: lastUserMsg.slice(0, 200),
      repairCount: Math.max(0, attempts.length - 1),
      parentVersionId: parent?.id ?? null,
      diffSummary,
    };
    const ok = await appendConversationVersion(conversationId, userId, v);
    if (ok) savedVersion = v;
  }
  return NextResponse.json({
    kind: 'report',
    message: final.message,
    report: finalReport,
    execution: final.execution,
    verification: { ok: true },
    savedVersion,
    repairs: sanitiseRepairs(attempts.slice(1), lang),
  });
}

// Strip raw Mongo / driver error strings from the repair history we hand
// back to the client. The user-facing UI renders these as chat bubbles, so
// any technical text here ends up in the conversation. We keep the report
// (so analysts can inspect intermediate pipelines via the versions panel)
// and the per-attempt success flag, but replace the error string with a
// short, non-technical phrase. Raw text lives only in server logs and in
// the persisted ConversationVersion document.
function sanitiseRepairs(attempts: Attempt[], lang: 'fa' | 'en'): Array<{
  message: string;
  report: LlmReport;
  execution: { ok: boolean; count?: number; took?: number; truncated?: boolean; error?: string };
  verification: Verdict;
}> {
  return attempts.map(a => ({
    message: a.message,
    report: a.report,
    execution: {
      ok: a.execution.ok,
      count: a.execution.count,
      took: a.execution.took,
      truncated: a.execution.truncated,
      error: a.execution.ok ? undefined : publicExecutionLabel(a.execution.error, lang),
    },
    verification: a.verification ?? { ok: true },
  }));
}
