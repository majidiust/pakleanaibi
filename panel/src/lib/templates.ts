// Shared helpers for the Saved Reports / Report Templates feature.
//
// Two responsibilities live here so the API routes stay thin:
//   1. Parameter substitution -- walking a stored aggregation pipeline and
//      replacing placeholders ("{{key}}" string tokens or {"$param": "key"}
//      objects) with user-supplied values, coerced to the right BSON type.
//   2. Static analysis -- pulling the set of collections referenced by the
//      pipeline and collecting fingerprints for every relationship that
//      backs a $lookup, so we can warn on drift when relationships are
//      changed after the template was saved.
import { ObjectId } from 'mongodb';
import type {
  TemplateParameter, TemplateRelationshipRef, IntelRelationship,
} from './intel/types';

// ---- Parameter substitution -------------------------------------------

export type ParamValues = Record<string, unknown>;

function coerce(p: TemplateParameter, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') {
    if (p.defaultValue !== undefined && p.defaultValue !== null) return coerce(p, p.defaultValue);
    return null;
  }
  switch (p.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw));
      if (!Number.isFinite(n)) throw new Error(`parameter "${p.key}" is not a number`);
      return n;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      return String(raw).toLowerCase() === 'true';
    case 'date': {
      const d = raw instanceof Date ? raw : new Date(String(raw));
      if (Number.isNaN(d.getTime())) throw new Error(`parameter "${p.key}" is not a valid date`);
      return d;
    }
    case 'objectId': {
      const s = String(raw);
      if (!ObjectId.isValid(s)) throw new Error(`parameter "${p.key}" is not a valid ObjectId`);
      return new ObjectId(s);
    }
    default:
      return String(raw);
  }
}

/** Replaces placeholders in `pipeline` using `values` keyed by parameter key.
 *  Supported syntaxes:
 *    - Bare string "{{key}}" anywhere in the pipeline -> replaced wholesale.
 *    - Object {"$param": "key"} -> replaced with the coerced value.
 *  Missing required parameters throw; missing optional ones fall back to the
 *  parameter's defaultValue, or null if none. */
export function applyParameters(
  pipeline: Record<string, unknown>[],
  params: TemplateParameter[],
  values: ParamValues,
): Record<string, unknown>[] {
  const byKey = new Map(params.map(p => [p.key, p]));
  // Resolve every declared parameter once so we throw early on bad input.
  const resolved = new Map<string, unknown>();
  for (const p of params) {
    const incoming = values[p.key];
    if ((incoming === undefined || incoming === null || incoming === '') && p.required && p.defaultValue === undefined) {
      throw new Error(`parameter "${p.key}" is required`);
    }
    resolved.set(p.key, coerce(p, incoming));
  }
  function lookup(key: string): unknown {
    if (!byKey.has(key)) throw new Error(`unknown parameter placeholder "${key}"`);
    return resolved.get(key) ?? null;
  }
  function walk(node: unknown): unknown {
    if (node === null) return node;
    if (typeof node === 'string') {
      // Whole-string placeholder, e.g. "{{from}}". Inline placeholders
      // inside larger strings are intentionally NOT supported -- they would
      // force a string coercion that hides BSON type mismatches.
      const m = /^\{\{\s*([A-Za-z_][\w-]*)\s*\}\}$/.exec(node);
      if (m) return lookup(m[1]);
      return node;
    }
    if (typeof node !== 'object') return node;
    if (node instanceof Date) return node;
    if (Array.isArray(node)) return node.map(walk);
    const o = node as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '$param') {
      const k = o.$param;
      if (typeof k !== 'string') throw new Error('$param key must be a string');
      return lookup(k);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = walk(v);
    return out;
  }
  return pipeline.map(s => walk(s) as Record<string, unknown>);
}

// ---- Static analysis ---------------------------------------------------

/** Returns the deduplicated list of collection names referenced by the
 *  pipeline: the anchor plus every $lookup.from / $unionWith.coll. */
export function pipelineCollections(anchor: string, pipeline: Record<string, unknown>[]): string[] {
  const set = new Set<string>([anchor]);
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const o = node as Record<string, unknown>;
    for (const [k, v] of Object.entries(o)) {
      if (k === '$lookup' && v && typeof v === 'object') {
        const from = (v as { from?: unknown }).from;
        if (typeof from === 'string') set.add(from);
      }
      if (k === '$unionWith') {
        if (typeof v === 'string') set.add(v);
        else if (v && typeof v === 'object') {
          const coll = (v as { coll?: unknown }).coll;
          if (typeof coll === 'string') set.add(coll);
        }
      }
      walk(v);
    }
  }
  for (const stage of pipeline) walk(stage);
  return [...set];
}

/** For each ($lookup.from, $lookup.localField, $lookup.foreignField) tuple
 *  found in the pipeline, look up the matching relationship in `rels` and
 *  return a snapshot ref. Lookups that don't match any approved/manual
 *  relationship are skipped silently -- they're treated as ad-hoc joins. */
export function collectUsedRelationships(
  anchor: string,
  pipeline: Record<string, unknown>[],
  rels: Pick<IntelRelationship, 'fingerprint' | 'source' | 'target' | 'type'>[],
): TemplateRelationshipRef[] {
  const refs: TemplateRelationshipRef[] = [];
  const seen = new Set<string>();
  // Track the most recent anchor for each $lookup. We assume each $lookup's
  // localField is rooted in the document shape produced by the prior stages,
  // which is the anchor collection (or a previously joined collection).
  function matchRel(from: string, localField: string, foreignField: string, side: 'forward' | 'reverse', srcColl: string): TemplateRelationshipRef | null {
    for (const r of rels) {
      const tgtKey = (r.target as { matchOn?: string }).matchOn ?? r.target.field;
      // Forward: anchor=source, lookup goes source -> target.
      if (side === 'forward' &&
          r.source.collection === srcColl && r.source.field === localField &&
          r.target.collection === from && tgtKey === foreignField) {
        return { fingerprint: r.fingerprint, source: r.source, target: r.target, type: r.type };
      }
      // Reverse: anchor=target, lookup goes target -> source.
      if (side === 'reverse' &&
          r.target.collection === srcColl && tgtKey === localField &&
          r.source.collection === from && r.source.field === foreignField) {
        return { fingerprint: r.fingerprint, source: r.source, target: r.target, type: r.type };
      }
    }
    return null;
  }
  for (const stage of pipeline) {
    const lk = (stage as Record<string, unknown>).$lookup as
      { from?: unknown; localField?: unknown; foreignField?: unknown } | undefined;
    if (!lk || typeof lk !== 'object') continue;
    const from = typeof lk.from === 'string' ? lk.from : null;
    const lf = typeof lk.localField === 'string' ? (lk.localField as string) : null;
    const ff = typeof lk.foreignField === 'string' ? (lk.foreignField as string) : null;
    if (!from || !lf || !ff) continue;
    // Strip any "<prevAs>." prefix to map back to the underlying field on the
    // anchor side. We only need the leaf field name for fingerprint matching.
    const localLeaf = lf.includes('.') ? lf.split('.').slice(1).join('.') : lf;
    const candidate =
      matchRel(from, localLeaf, ff, 'forward', anchor) ??
      matchRel(from, localLeaf, ff, 'reverse', anchor);
    if (candidate && !seen.has(candidate.fingerprint)) {
      seen.add(candidate.fingerprint);
      refs.push(candidate);
    }
  }
  return refs;
}

/** Compares the relationships a template was built against to the current
 *  approved/manual set. Returns the list of fingerprints that no longer
 *  exist (deleted, rejected, or archived) so the UI can warn the user. */
export function detectDrift(
  saved: TemplateRelationshipRef[],
  current: { fingerprint: string }[],
): { missing: TemplateRelationshipRef[] } {
  const live = new Set(current.map(r => r.fingerprint));
  return { missing: saved.filter(r => !live.has(r.fingerprint)) };
}
