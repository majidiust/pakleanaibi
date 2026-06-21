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

export interface ValidatedPipeline {
  collection: string;
  pipeline: Record<string, unknown>[];
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

  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < input.pipeline.length; i++) {
    const stage = input.pipeline[i];
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
