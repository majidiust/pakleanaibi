// Schema discovery: walks sampled documents and produces field-level metadata.
// Designed to be safe against huge collections: uses $sample, bounds memory by
// capping distinct/example counters, and skips obviously sensitive fields when
// retaining example values.
import { ObjectId, Long, Double, Decimal128, Binary, Timestamp } from 'mongodb';
import { dataDb } from '../mongo';
import type { FieldSample, FieldType, IntelCollection } from './types';

export const SAMPLE_DEFAULT = 200;
export const MAX_DISTINCT = 50;
export const MAX_EXAMPLES = 5;
export const MAX_ENUM_DISTINCT = 12;
export const MAX_FIELDS = 200;

const SECRET_HINTS = /(password|passwd|pwd|secret|token|apikey|api_key|otp|2fa|hash|salt)/i;
const TIMESTAMP_HINTS = /^(created|updated|modified|deleted|last|expires|expiry|published|seen)([_a-z]*)(at|on|date|time)?$|^(ts|timestamp|date)$/i;
const ID_HEX24 = /^[0-9a-fA-F]{24}$/;

function classify(v: unknown): FieldType {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Date) return 'date';
  if (v instanceof ObjectId) return 'objectId';
  if (v instanceof Long) return 'long';
  if (v instanceof Double) return 'double';
  if (v instanceof Decimal128) return 'decimal';
  if (v instanceof Binary) return 'binary';
  if (v instanceof Timestamp) return 'date';
  if (v instanceof RegExp) return 'regex';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'boolean') return 'boolean';
  return 'mixed';
}

// Internal accumulator: kept as a Map keyed by dot-path for O(1) field lookup.
interface Acc {
  types: Set<FieldType>;
  arrayOf: Set<FieldType>;
  present: number;
  nulls: number;
  distinct: Map<unknown, number>;   // value -> count, capped at MAX_DISTINCT
  examples: unknown[];
  hexIdHits: number;
  hexIdChecks: number;
}

function newAcc(): Acc {
  return {
    types: new Set(), arrayOf: new Set(),
    present: 0, nulls: 0,
    distinct: new Map(), examples: [],
    hexIdHits: 0, hexIdChecks: 0,
  };
}

function recordValue(acc: Acc, v: unknown, isSecret: boolean) {
  acc.present++;
  const t = classify(v);
  acc.types.add(t);
  if (v === null || v === undefined) { acc.nulls++; return; }

  if (Array.isArray(v)) {
    for (const el of v) acc.arrayOf.add(classify(el));
  }

  // Distinct tracking only for scalar-ish values to keep memory bounded.
  if (t !== 'object' && t !== 'array' && t !== 'binary') {
    if (acc.distinct.size < MAX_DISTINCT) {
      const k = t === 'objectId' ? String(v) : (v as object);
      acc.distinct.set(k, (acc.distinct.get(k) ?? 0) + 1);
    }
  }
  if (t === 'string') {
    acc.hexIdChecks++;
    if (ID_HEX24.test(v as string)) acc.hexIdHits++;
  }
  if (acc.examples.length < MAX_EXAMPLES && !isSecret) {
    acc.examples.push(t === 'objectId' ? String(v) : v);
  }
}

// Recursively walks a document, accumulating per-path metadata. Object trees
// deeper than 4 levels are summarised at the parent level to keep field count
// bounded on highly nested documents.
function walk(doc: Record<string, unknown>, byPath: Map<string, Acc>, prefix = '', depth = 0) {
  for (const [k, v] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const isSecret = SECRET_HINTS.test(k);
    let acc = byPath.get(path);
    if (!acc) { acc = newAcc(); byPath.set(path, acc); }
    recordValue(acc, v, isSecret);
    if (depth < 4 && v && typeof v === 'object' && !Array.isArray(v) &&
        !(v instanceof Date) && !(v instanceof ObjectId) &&
        !(v instanceof Binary) && !(v instanceof Decimal128) &&
        !(v instanceof Long) && !(v instanceof Double)) {
      walk(v as Record<string, unknown>, byPath, path, depth + 1);
    }
  }
}

function isEnumish(acc: Acc, totalDocs: number): (string | number | boolean)[] | undefined {
  if (acc.distinct.size === 0 || acc.distinct.size > MAX_ENUM_DISTINCT) return undefined;
  const onlyScalar = [...acc.types].every(t => ['string', 'integer', 'number', 'boolean'].includes(t));
  if (!onlyScalar) return undefined;
  // Enum-like if every present doc maps to a known value AND distinct < 20% of present.
  const ratio = acc.distinct.size / Math.max(acc.present, 1);
  if (ratio > 0.2 && acc.distinct.size > 4) return undefined;
  if (acc.present < Math.min(10, totalDocs)) return undefined;
  return [...acc.distinct.keys()] as (string | number | boolean)[];
}

export async function sampleCollection(name: string, size = SAMPLE_DEFAULT): Promise<{
  fields: FieldSample[]; samples: unknown[]; docCount: number;
  indexes: IntelCollection['indexes'];
}> {
  const db = await dataDb();
  const coll = db.collection(name);
  const [docCount, docs, rawIdx] = await Promise.all([
    coll.estimatedDocumentCount(),
    coll.aggregate<Record<string, unknown>>(
      [{ $sample: { size } }],
      { maxTimeMS: 15000, allowDiskUse: false },
    ).toArray(),
    coll.indexes().catch(() => []),
  ]);
  const byPath = new Map<string, Acc>();
  for (const d of docs) walk(d, byPath);

  const total = docs.length || 1;
  const fields: FieldSample[] = [...byPath.entries()]
    .slice(0, MAX_FIELDS)
    .map(([path, acc]) => {
      const presence = +(acc.present / total).toFixed(3);
      const nullRate = +(acc.nulls / Math.max(acc.present, 1)).toFixed(3);
      const distinctCount = acc.distinct.size;
      const nonNull = Math.max(acc.present - acc.nulls, 1);
      const uniqueness = +(distinctCount / nonNull).toFixed(3);
      const looksLikeObjectIdString = acc.hexIdChecks >= 5 &&
        acc.hexIdHits / acc.hexIdChecks >= 0.9;
      const isTimestamp = TIMESTAMP_HINTS.test(path.split('.').pop() ?? '') ||
        [...acc.types].includes('date');
      const enumValues = isEnumish(acc, total);
      const types = [...acc.types].filter(t => t !== 'null').sort();
      const arrayOf = acc.arrayOf.size ? [...acc.arrayOf].sort() : undefined;
      return {
        path, types: types as FieldType[], arrayOf: arrayOf as FieldType[] | undefined,
        presence, nullRate, distinctCount, uniqueness,
        enumValues, looksLikeObjectIdString, isTimestamp,
        examples: acc.examples,
      };
    })
    .sort((a, b) => b.presence - a.presence || a.path.localeCompare(b.path));

  const indexes = rawIdx.map(i => ({
    name: i.name as string,
    keys: i.key as Record<string, 1 | -1 | 'text'>,
    unique: !!i.unique,
  }));

  // Trim sample docs to a handful for the detail page; keep them small.
  const samples = docs.slice(0, 3).map(d => trimDoc(d, 0));
  return { fields, samples, docCount, indexes };
}

function trimDoc(v: unknown, depth: number): unknown {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof ObjectId) return String(v);
  if (Array.isArray(v)) return v.slice(0, 5).map(x => trimDoc(x, depth + 1));
  if (typeof v === 'object') {
    if (depth > 3) return '[…]';
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, val] of Object.entries(v)) {
      if (n++ >= 20) { out['…'] = `${Object.keys(v).length - 20} more`; break; }
      out[k] = SECRET_HINTS.test(k) ? '«redacted»' : trimDoc(val, depth + 1);
    }
    return out;
  }
  return v;
}

export function inferTags(name: string, fields: FieldSample[]): string[] {
  const tags = new Set<string>();
  const lower = name.toLowerCase();
  if (/user|account|profile|member/.test(lower)) tags.add('identity');
  if (/order|cart|checkout|purchase|invoice/.test(lower)) tags.add('commerce');
  if (/payment|transaction|wallet|ledger|balance/.test(lower)) tags.add('finance');
  if (/business|store|shop|merchant|vendor/.test(lower)) tags.add('business');
  if (/product|item|catalog|sku/.test(lower)) tags.add('catalog');
  if (/log|event|audit|history/.test(lower)) tags.add('telemetry');
  if (/session|token|otp|2fa|auth/.test(lower)) tags.add('auth');
  if (fields.some(f => f.isTimestamp && /created/i.test(f.path))) tags.add('timestamped');
  if (fields.some(f => /^email$|\.email$/.test(f.path))) tags.add('email');
  if (fields.some(f => /status|state/i.test(f.path) && f.enumValues)) tags.add('stateful');
  return [...tags];
}
