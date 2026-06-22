import { env } from './env';

// Allowlist-based validator for LLM-generated aggregation pipelines.
// Anything not explicitly permitted is rejected so that "read-only" is enforced
// at the application layer regardless of MongoDB user privileges.
const ALLOWED_STAGES = new Set([
  '$match', '$project', '$group', '$sort', '$limit', '$skip', '$count',
  '$addFields', '$set', '$unset', '$unwind', '$replaceRoot', '$replaceWith',
  '$bucket', '$bucketAuto', '$facet', '$sortByCount', '$lookup', '$densify',
]);
const FORBIDDEN_OPERATORS = new Set([
  '$out', '$merge', '$function', '$accumulator', '$where',
  '$listLocalSessions', '$listSessions', '$indexStats', '$collStats',
  '$planCacheStats', '$currentOp', '$changeStream',
]);

// Operators that exist only on specific MongoDB versions. When the target
// server is older than the minimum, the lowering pass tries to rewrite the
// expression into something the server can evaluate; if it can't, validation
// throws so the agentic self-repair loop sees a clear error.
const MIN_VERSION: Record<string, [number, number]> = {
  $dateSubtract: [5, 0],
  $dateAdd: [5, 0],
  $dateDiff: [5, 0],
  $dateTrunc: [5, 0],
  // $$NOW / $$CLUSTER_TIME (variables, not operators) are 4.2+; handled in lower().
};

export interface ValidatedPipeline {
  collection: string;
  pipeline: Record<string, unknown>[];
}

// Recursively normalize object keys: trim surrounding whitespace, fold any
// internal whitespace before a `$` so `" $first"` / `"$ first"` / `"$first "`
// all become `"$first"`. LLMs occasionally insert leading spaces before
// accumulator operators (which MongoDB then rejects with "must be an
// accumulator object").
function sanitizeKeys(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(sanitizeKeys);
  const out: Record<string, unknown> = {};
  for (const [rawK, v] of Object.entries(node as Record<string, unknown>)) {
    let k = rawK.trim();
    if (k.startsWith('$')) k = '$' + k.slice(1).replace(/\s+/g, '');
    out[k] = sanitizeKeys(v);
  }
  return out;
}

function deepCheck(node: unknown, path: string): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((c, i) => deepCheck(c, `${path}[${i}]`)); return; }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (FORBIDDEN_OPERATORS.has(k)) {
      throw new Error(`Forbidden operator ${k} at ${path}`);
    }
    if (k.startsWith('$') && k.toLowerCase().includes('eval')) {
      throw new Error(`Forbidden expression ${k} at ${path}`);
    }
    deepCheck(v, `${path}.${k}`);
  }
}

export function validatePipeline(input: {
  collection: unknown;
  pipeline: unknown;
}): ValidatedPipeline {
  if (typeof input.collection !== 'string' || !/^[a-zA-Z0-9_.-]{1,120}$/.test(input.collection)) {
    throw new Error('Invalid collection name');
  }
  if (!Array.isArray(input.pipeline)) throw new Error('pipeline must be an array');
  if (input.pipeline.length === 0) throw new Error('pipeline must not be empty');
  if (input.pipeline.length > 24) throw new Error('pipeline too long');

  // Sanitize keys (trim whitespace, fold internal whitespace after $) BEFORE
  // any other check — see comment on sanitizeKeys above.
  const normalized = sanitizeKeys(input.pipeline) as unknown[];

  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const stage = normalized[i];
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      throw new Error(`stage[${i}] must be an object`);
    }
    const keys = Object.keys(stage);
    if (keys.length !== 1) throw new Error(`stage[${i}] must have exactly one operator`);
    const op = keys[0];
    if (!ALLOWED_STAGES.has(op)) throw new Error(`stage[${i}]: ${op} is not allowed`);
    deepCheck(stage, `stage[${i}]`);
    out.push(stage as Record<string, unknown>);
  }

  // Force-cap the result size. We do this regardless of what the model emits.
  const last = out[out.length - 1];
  const hasFinalLimit = last && typeof last === 'object' && '$limit' in last;
  if (!hasFinalLimit) out.push({ $limit: env.REPORT_MAX_ROWS });
  else {
    const v = (last as { $limit: unknown }).$limit;
    if (typeof v !== 'number' || v <= 0 || v > env.REPORT_MAX_ROWS) {
      (last as { $limit: number }).$limit = env.REPORT_MAX_ROWS;
    }
  }

  return { collection: input.collection, pipeline: out };
}

// --- Server-version aware lowering ----------------------------------------
// The LLM is asked to produce pipelines compatible with the target server,
// but legacy databases (e.g. 3.4) don't have $$NOW or $dateSubtract. We
// rewrite a small set of common time-math idioms into pre-computed literals
// so the same pipeline can run on legacy servers. Anything we can't lower
// throws, so the agentic self-repair loop receives a clear, actionable
// error instead of MongoDB silently returning 0 rows.

const UNIT_MS: Record<string, number> = {
  millisecond: 1, milliseconds: 1,
  second: 1000, seconds: 1000,
  minute: 60_000, minutes: 60_000,
  hour: 3_600_000, hours: 3_600_000,
  day: 86_400_000, days: 86_400_000,
  week: 7 * 86_400_000, weeks: 7 * 86_400_000,
};

function resolveLiteralDate(expr: unknown, now: Date): Date | null {
  if (expr instanceof Date) return expr;
  if (expr === '$$NOW' || expr === '$$CLUSTER_TIME') return now;
  if (typeof expr === 'string' && /^\d{4}-\d{2}-\d{2}/.test(expr)) {
    const d = new Date(expr);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (expr && typeof expr === 'object' && !Array.isArray(expr)) {
    const o = expr as Record<string, unknown>;
    if (o.$literal instanceof Date) return o.$literal;
    if (o.$date) {
      const d = new Date(o.$date as string | number);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (o.$dateFromString && typeof o.$dateFromString === 'object') {
      const inner = (o.$dateFromString as { dateString?: unknown }).dateString;
      if (typeof inner === 'string') {
        const d = new Date(inner);
        return Number.isNaN(d.getTime()) ? null : d;
      }
    }
    if (o.$dateSubtract || o.$dateAdd) return resolveDateArithmetic(o, now);
  }
  return null;
}

function resolveDateArithmetic(
  node: Record<string, unknown>,
  now: Date,
): Date | null {
  const isSub = '$dateSubtract' in node;
  const spec = (node.$dateSubtract ?? node.$dateAdd) as Record<string, unknown> | undefined;
  if (!spec || typeof spec !== 'object') return null;
  const base = resolveLiteralDate(spec.startDate, now);
  const unit = String(spec.unit ?? '').toLowerCase();
  const amount = Number(spec.amount);
  const ms = UNIT_MS[unit];
  if (!base || !ms || !Number.isFinite(amount)) return null;
  return new Date(base.getTime() + (isSub ? -1 : 1) * amount * ms);
}

// Walks the pipeline; whenever it finds an operator that is unsupported on
// the running server it tries to lower it. Returns the rewritten pipeline.
// `version`: [major, minor] tuple, e.g. [3, 4].
export function lowerPipeline(
  pipeline: Record<string, unknown>[],
  version: [number, number],
): Record<string, unknown>[] {
  const now = new Date();
  function supports(op: string): boolean {
    const min = MIN_VERSION[op];
    if (!min) return true;
    return version[0] > min[0] || (version[0] === min[0] && version[1] >= min[1]);
  }
  function walk(node: unknown): unknown {
    if (node === null || typeof node !== 'object') {
      if (node === '$$NOW' || node === '$$CLUSTER_TIME') {
        // 4.2+ variable; on older servers, freeze to wall-clock at submit time.
        if (version[0] > 4 || (version[0] === 4 && version[1] >= 2)) return node;
        return now;
      }
      return node;
    }
    if (node instanceof Date) return node;
    if (Array.isArray(node)) return node.map(walk);
    const o = node as Record<string, unknown>;
    // EJSON date literal -> real BSON Date. Required everywhere because the
    // MongoDB driver, when handed a plain {$date: "..."} object as a query
    // value, does NOT auto-decode it; it sends it as an embedded document
    // and the server compares Date >= Object -- which silently matches
    // nothing under BSON type bracketing. We unconditionally rewrite so the
    // driver serialises a real Date.
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '$date') {
      const v = o.$date;
      let ms: number | string | null = null;
      if (typeof v === 'string' || typeof v === 'number') ms = v;
      else if (v && typeof v === 'object' && '$numberLong' in (v as Record<string, unknown>)) {
        ms = Number((v as { $numberLong: unknown }).$numberLong);
      }
      if (ms !== null) {
        const d = new Date(ms);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }
    // Lower $dateSubtract / $dateAdd if not supported.
    for (const op of ['$dateSubtract', '$dateAdd'] as const) {
      if (op in o && !supports(op)) {
        const lit = resolveDateArithmetic(o, now);
        if (!lit) {
          throw new Error(
            `${op} on MongoDB ${version.join('.')} requires a literal startDate; ` +
            `use ISO date strings or omit time math.`,
          );
        }
        // Replace the whole object with the literal Date so the parent expr
        // sees a concrete value (e.g. inside $match.$gte).
        return lit;
      }
    }
    if ('$dateTrunc' in o && !supports('$dateTrunc')) {
      throw new Error(
        `$dateTrunc is unsupported on MongoDB ${version.join('.')}; ` +
        `use $dateToString with format strings for time bucketing.`,
      );
    }
    if ('$dateDiff' in o && !supports('$dateDiff')) {
      throw new Error(
        `$dateDiff is unsupported on MongoDB ${version.join('.')}; ` +
        `compute differences with $subtract on dates instead.`,
      );
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = walk(v);
    return out;
  }
  return pipeline.map(stage => walk(stage) as Record<string, unknown>);
}
