import { ObjectId, Long } from 'mongodb';
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
// internal whitespace after a `$` so `" $first"` / `"$ first"` / `"$first "`
// all become `"$first"`, and rewrite `&` -> `$` at the start of operator
// keys (LLMs occasionally emit `"&and"` / `"&eq"` instead of `"$and"`).
// Any operator-shaped key with illegal characters in the body (`":"`, `"["`,
// `"("`, `","`) is left alone here so the downstream validator can throw a
// useful error pointing at the original key.
const OP_BODY = /^[A-Za-z][A-Za-z0-9_]*$/;
function sanitizeKeys(node: unknown): unknown {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(sanitizeKeys);
  const out: Record<string, unknown> = {};
  for (const [rawK, v] of Object.entries(node as Record<string, unknown>)) {
    let k = rawK.trim();
    if (k.startsWith('&') && OP_BODY.test(k.slice(1))) k = '$' + k.slice(1);
    if (k.startsWith('$')) k = '$' + k.slice(1).replace(/\s+/g, '');
    out[k] = sanitizeKeys(v);
  }
  return out;
}

// Walk every object key. Operator-shaped keys (start with `$`) must have a
// clean identifier body; anything else (`$eq:[`, `$gte(`, `$and,`) means the
// model serialised an entire expression as a key — MongoDB will reject this
// with confusing duplicate-field errors. Throwing here gives the repair loop
// a clear, actionable message instead.
function assertOperatorKeysWellFormed(node: unknown, path: string): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((c, i) => assertOperatorKeysWellFormed(c, `${path}[${i}]`)); return; }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k.startsWith('$') && !OP_BODY.test(k.slice(1))) {
      throw new Error(
        `Malformed operator key "${k}" at ${path}. Each operator must be a ` +
        `clean key with its value as an object/array, e.g. {"$eq": ["$field", "value"]}. ` +
        `Never put the operator's arguments inside the key itself.`,
      );
    }
    assertOperatorKeysWellFormed(v, `${path}.${k}`);
  }
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

  // Sanitize keys (trim whitespace, fold internal whitespace after $, rewrite
  // `&op` -> `$op`) BEFORE any other check. Then assert that every operator
  // key has a clean identifier body so malformed shapes like `"$eq:["` are
  // caught here with an actionable error instead of bubbling up as a
  // confusing duplicate-field error from MongoDB at execution time.
  const normalized = sanitizeKeys(input.pipeline) as unknown[];
  assertOperatorKeysWellFormed(normalized, 'pipeline');

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

  // Normalize bare scalar literals inside $project specs. On MongoDB 3.4
  // (and ambiguously across other versions) any non-0/1 number on the
  // right-hand side of a $project field is treated as inclusion of a
  // (usually non-existent) path, so the constant value never reaches the
  // output document. The canonical way to emit a constant is $literal.
  // LLMs forget this routinely; we rewrite here so the table renders the
  // intended column instead of silently dropping it.
  const final = out.map(wrapProjectLiterals);
  return { collection: input.collection, pipeline: final };
}

function wrapProjectLiterals(stage: Record<string, unknown>): Record<string, unknown> {
  const op = Object.keys(stage)[0];
  if (op !== '$project') return stage;
  const spec = stage[op];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return stage;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(spec as Record<string, unknown>)) {
    next[k] = k.startsWith('$') ? v : wrapValueIfLiteral(v);
  }
  return { [op]: next };
}

function wrapValueIfLiteral(v: unknown): unknown {
  // Inclusion / exclusion sentinels — preserve semantics.
  if (v === 0 || v === 1 || v === true || v === false) return v;
  // Field path reference — preserve.
  if (typeof v === 'string' && v.startsWith('$')) return v;
  // Bare numeric literal (e.g. 0.5, 100, -3) — wrap.
  if (typeof v === 'number') return { $literal: v };
  // Bare string literal without "$" prefix — wrap.
  if (typeof v === 'string') return { $literal: v };
  // Expression objects, sub-spec objects, arrays, null: leave alone.
  return v;
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
    // EJSON literals -> real BSON values. The MongoDB driver does NOT
    // auto-decode shorthand wrappers like {$date:...} / {$oid:...} when
    // they appear as values inside a pipeline document tree — it ships
    // them verbatim, and the server then either compares against an
    // embedded document (silent zero rows) or, when the wrapper lands
    // inside an expression context such as $eq/$cond/$addFields, tries
    // to dispatch the wrapper key as an operator and throws
    // "Unrecognized expression '$oid'". Decoding here once means the
    // same {$oid:...} literal works in $match, $expr, $addFields, $project
    // — anywhere the analyst (or LLM) writes it.
    const keys = Object.keys(o);
    if (keys.length === 1) {
      const k0 = keys[0];
      if (k0 === '$date') {
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
      if (k0 === '$oid' && typeof o.$oid === 'string' && /^[a-f0-9]{24}$/i.test(o.$oid)) {
        try { return new ObjectId(o.$oid); } catch { /* fall through to verbatim walk */ }
      }
      if (k0 === '$numberLong' && (typeof o.$numberLong === 'string' || typeof o.$numberLong === 'number')) {
        try { return Long.fromString(String(o.$numberLong)); } catch { /* ignore */ }
      }
      if (k0 === '$numberInt' && (typeof o.$numberInt === 'string' || typeof o.$numberInt === 'number')) {
        const n = parseInt(String(o.$numberInt), 10);
        if (Number.isFinite(n)) return n;
      }
      if (k0 === '$numberDouble' && (typeof o.$numberDouble === 'string' || typeof o.$numberDouble === 'number')) {
        const n = parseFloat(String(o.$numberDouble));
        if (Number.isFinite(n)) return n;
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
    for (const [k, v] of Object.entries(o)) {
      // Safety net: when the LLM ignores the EJSON {$date:...} rule and
      // emits a bare ISO-8601 string as the right-hand side of a date
      // comparison ($gte/$gt/$lt/$lte/$eq/$ne), coerce it to a real Date
      // here. Without this, comparing a BSON Date field against a string
      // silently matches nothing under MongoDB's type bracketing rules.
      // The pattern is restrictive (full ISO timestamp with seconds and
      // a Z or offset) so we don't accidentally promote ordinary strings.
      if (COMP_OPS.has(k) && typeof v === 'string' && ISO_DT.test(v)) {
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) { out[k] = d; continue; }
      }
      out[k] = walk(v);
    }
    return out;
  }
  return pipeline.map(stage => walk(stage) as Record<string, unknown>);
}

const COMP_OPS = new Set(['$gte', '$gt', '$lt', '$lte', '$eq', '$ne']);
// Conservative ISO-8601 datetime pattern: YYYY-MM-DDTHH:MM(:SS(.fff))?(Z|+HH:MM).
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/;
