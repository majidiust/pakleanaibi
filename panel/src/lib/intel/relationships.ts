// Database-agnostic relationship discovery.
//
// The engine never assumes specific collections (no "users", "orders", ...)
// or specific field names. It only consumes:
//   1) The metadata produced by discover.ts (field paths incl. nested,
//      types, examples, uniqueness, presence, arrayOf, indexes).
//   2) The supplied corpus of collections (names + identifier fields).
//   3) Optional value-level probes against the live data DB to confirm that
//      a candidate source value actually exists in a candidate target.
import { ObjectId } from 'mongodb';
import { dataDb } from '../mongo';
import type {
  IntelCollection, IntelRelationship, RelationshipType,
  DetectionMethod, FieldSample,
} from './types';
import { intelLearning } from './storage';
import {
  tokens, singular, nameSimilarity, inferAbbreviations, type NameMatch,
} from './naming';

interface Signal { label: string; weight: number; note?: string }

function fingerprint(r: Pick<IntelRelationship, 'source' | 'target' | 'type'>): string {
  return [r.source.collection, r.source.field, r.target.collection, r.target.field, r.type].join('::');
}
export function relFingerprint(r: Pick<IntelRelationship, 'source' | 'target' | 'type'>): string {
  return fingerprint(r);
}

function scoreFrom(signals: Signal[]): number {
  const total = signals.reduce((a, s) => a + s.weight, 0);
  return Math.max(0, Math.min(100, Math.round(total)));
}

async function applyLearning(rel: Pick<IntelRelationship, 'source' | 'target' | 'type'>, signals: Signal[]) {
  const coll = await intelLearning();
  const pat = `${rel.source.collection}.${rel.source.field}->${rel.target.collection}:${rel.type}`;
  const hit = await coll.findOne({ pattern: pat });
  if (hit) signals.push({
    label: hit.delta > 0 ? 'previously approved pattern' : 'previously rejected pattern',
    weight: hit.delta * 15, note: hit.hint,
  });
}

// ----- Target-candidate index ---------------------------------------------
// Each collection contributes its tokenised name and every field that looks
// like an identifier the rest of the corpus might point at:
//   * _id (always),
//   * any field referenced by a single-key unique index,
//   * any field whose sampled uniqueness >= 0.95 with reasonable presence.
interface TargetField { path: string; types: Set<string>; unique: boolean }
interface TargetColl  { coll: IntelCollection; nameSing: string[]; identifiers: TargetField[] }

function buildTargetIndex(collections: IntelCollection[]): TargetColl[] {
  return collections.map(c => {
    const ids: TargetField[] = [{ path: '_id', types: new Set(['objectId']), unique: true }];
    const uniqIdx = new Set<string>();
    for (const idx of c.indexes) {
      const keys = Object.keys(idx.keys);
      if (idx.unique && keys.length === 1) uniqIdx.add(keys[0]);
    }
    for (const f of c.fields) {
      if (f.path === '_id') continue;
      const looksUnique = uniqIdx.has(f.path) || (f.uniqueness >= 0.95 && f.presence >= 0.5);
      if (!looksUnique) continue;
      ids.push({ path: f.path, types: new Set<string>(f.types as string[]), unique: true });
    }
    return { coll: c, nameSing: tokens(c.name).map(singular), identifiers: ids };
  });
}

// ----- FK suffix inference (data-driven) ---------------------------------
// We start from a tiny set of universally-recognised identifier suffixes
// ("id", "ref", "key", ...) and augment with any short trailing token that
// appears as the last segment of many multi-token field names across the
// corpus and is NOT itself a target collection name.
const BASE_SUFFIXES = ['id', 'ids', 'oid', 'ref', 'refs', 'key', 'keys', 'no', 'num', 'code'];
function inferSuffixes(corpus: IntelCollection[]): Set<string> {
  const counts = new Map<string, number>();
  for (const c of corpus) for (const f of c.fields) {
    const tk = tokens(f.path.split('.').pop() ?? '');
    if (tk.length < 2) continue;
    const last = tk[tk.length - 1];
    counts.set(last, (counts.get(last) ?? 0) + 1);
  }
  const collNames = new Set<string>(corpus.flatMap(c => tokens(c.name).map(singular)));
  const set = new Set<string>(BASE_SUFFIXES);
  for (const [tok, n] of counts) {
    if (n >= 3 && tok.length <= 4 && !collNames.has(singular(tok))) set.add(tok);
  }
  return set;
}

interface Stem { stem: string; trailingPlural: boolean }
function stemFromFieldName(path: string, suffixes: Set<string>): Stem | null {
  const last = path.split('.').pop() ?? '';
  const tk = tokens(last);
  if (!tk.length) return null;
  let i = tk.length;
  while (i > 0 && suffixes.has(tk[i - 1])) i--;
  if (i === 0) return null;
  const trailingPlural = i < tk.length && /s$/.test(tk[i]); // userIds -> plural ref
  const head = tk.slice(0, i).map(singular);
  if (!head.length) return null;
  return { stem: head.join(''), trailingPlural };
}

// ----- Value-level probe --------------------------------------------------
async function probeValueMatch(field: FieldSample, target: TargetColl, tf: TargetField): Promise<{
  checked: number; matched: number; sample: unknown[];
}> {
  const exs = (field.examples ?? []).filter(v => v !== null && v !== undefined);
  if (!exs.length) return { checked: 0, matched: 0, sample: [] };

  let candidates: unknown[] = [];
  for (const v of exs) {
    if (Array.isArray(v)) { for (const el of v) candidates.push(el); }
    else if (typeof v === 'object' && !(v instanceof ObjectId)) continue; // skip raw embedded
    else candidates.push(v);
    if (candidates.length >= 8) break;
  }
  candidates = candidates.slice(0, 8);

  const targetIsOid = tf.types.has('objectId');
  const coerced: unknown[] = [];
  for (const v of candidates) {
    if (targetIsOid) {
      if (v instanceof ObjectId) coerced.push(v);
      else if (typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v)) {
        try { coerced.push(new ObjectId(v)); } catch { /* ignore */ }
      }
    } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      coerced.push(v);
    }
  }
  if (!coerced.length) return { checked: 0, matched: 0, sample: [] };

  const db = await dataDb();
  const matched = await db.collection(target.coll.name)
    .countDocuments(
      { [tf.path]: { $in: coerced } } as Record<string, unknown>,
      { limit: coerced.length, maxTimeMS: 5000 },
    )
    .catch(() => 0);
  return {
    checked: coerced.length, matched,
    sample: coerced.slice(0, 3).map(v => v instanceof ObjectId ? String(v) : v),
  };
}

// ----- Direction / cardinality from sampled data --------------------------
function classifyDirection(src: FieldSample, srcIsArray: boolean, tgtUnique: boolean):
  { type: RelationshipType; cardinality: '1:1' | '1:N' | 'N:1' | 'N:N' } {
  if (srcIsArray) {
    return tgtUnique ? { type: 'many-to-many', cardinality: 'N:N' }
                     : { type: 'one-to-many',  cardinality: '1:N' };
  }
  if (src.uniqueness >= 0.95) {
    return tgtUnique ? { type: 'one-to-one',  cardinality: '1:1' }
                     : { type: 'one-to-many', cardinality: '1:N' };
  }
  return { type: 'many-to-one', cardinality: 'N:1' };
}

// ----- Per-candidate evaluation -------------------------------------------
async function evaluateCandidate(
  source: IntelCollection, field: FieldSample,
  target: TargetColl, tf: TargetField, nm: NameMatch,
): Promise<IntelRelationship | null> {
  const srcTypes = new Set<string>(field.types as string[]);
  const arrEl = new Set<string>(field.arrayOf ?? []);
  const sourceIsArray = srcTypes.has('array');
  const targetIsOid = tf.types.has('objectId');

  const isOidLike =
    srcTypes.has('objectId') || arrEl.has('objectId') ||
    (!!field.looksLikeObjectIdString && (srcTypes.has('string') || arrEl.has('string')));

  // ---- Type-compatibility gate ----
  let typeFit = 0; const typeReasons: string[] = [];
  if (targetIsOid) {
    if (!isOidLike) return null;
    typeFit = 1; typeReasons.push('ObjectId-compatible');
  } else {
    const overlap = new Set<string>([...srcTypes, ...arrEl].filter(t => tf.types.has(t)));
    overlap.delete('null'); overlap.delete('array'); overlap.delete('object');
    if (!overlap.size) return null;
    typeFit = 0.7; typeReasons.push(`scalar type overlap (${[...overlap].join('|')})`);
  }

  const probe = await probeValueMatch(field, target, tf).catch(() => ({ checked: 0, matched: 0, sample: [] as unknown[] }));

  const signals: Signal[] = [
    { label: 'name similarity', weight: Math.round(nm.score * 30),
      note: nm.evidence.join('; ') || undefined },
    { label: 'type compatibility', weight: Math.round(typeFit * 25),
      note: typeReasons.join('; ') || undefined },
  ];
  if (tf.unique && tf.path !== '_id') {
    signals.push({ label: `target field is unique (${tf.path})`, weight: 5 });
  }
  if (probe.checked) {
    const ratio = probe.matched / probe.checked;
    signals.push({
      label: `value match ${probe.matched}/${probe.checked} in ${target.coll.name}.${tf.path}`,
      weight: Math.round(ratio * 40),
      note: probe.sample.length ? `samples: ${probe.sample.map(String).join(', ')}` : undefined,
    });
    if (probe.matched === 0) {
      signals.push({ label: 'no sampled value found in target', weight: -25 });
    }
  } else {
    signals.push({ label: 'no values available for live validation', weight: -10 });
  }

  const { type, cardinality } = classifyDirection(field, sourceIsArray, tf.unique);
  const detection: DetectionMethod = targetIsOid
    ? (srcTypes.has('objectId') || arrEl.has('objectId') ? 'objectId-naming' : 'objectId-value')
    : 'soft-value';

  const rel: IntelRelationship = {
    fingerprint: fingerprint({
      source: { collection: source.name, field: field.path },
      target: { collection: target.coll.name, field: tf.path }, type,
    }),
    source: { collection: source.name, field: field.path },
    target: {
      collection: target.coll.name, field: tf.path,
      matchOn: tf.path === '_id' ? undefined : tf.path,
    },
    type, cardinality,
    status: 'suggested', confidence: 0, detection,
    reason: '', signals, tags: [],
    createdAt: new Date(), updatedAt: new Date(),
  };
  await applyLearning(rel, signals);
  rel.confidence = scoreFrom(signals);

  const bits = [`Field '${rel.source.field}' in ${rel.source.collection} likely references ${rel.target.collection}.${rel.target.field}.`];
  if (nm.evidence.length) bits.push(`Naming: ${nm.evidence.join('; ')}.`);
  if (probe.checked) bits.push(`Live probe: ${probe.matched}/${probe.checked} sampled values existed in target.`);
  else bits.push('Live probe skipped (no sampled values available); suggested by naming + types only.');
  rel.reason = bits.join(' ');
  return rel;
}

// ----- Embedded entity detection -----------------------------------------
function tryEmbedded(source: IntelCollection, field: FieldSample): IntelRelationship | null {
  const types = new Set<string>(field.types as string[]);
  const arr = new Set<string>(field.arrayOf ?? []);
  const isEmbedded = types.has('object') || arr.has('object');
  if (!isEmbedded) return null;
  const hasNestedId = source.fields.some(f =>
    f.path.startsWith(field.path + '.') && /(^|\.)(_id|id)$/i.test(f.path));
  if (!hasNestedId) return null;
  const signals: Signal[] = [
    { label: 'embedded object structure detected', weight: 60 },
    { label: 'sub-document carries its own id-like field', weight: 25 },
  ];
  return {
    fingerprint: fingerprint({
      source: { collection: source.name, field: field.path },
      target: { collection: source.name, field: field.path }, type: 'embedded',
    }),
    source: { collection: source.name, field: field.path },
    target: { collection: source.name, field: field.path },
    type: 'embedded',
    cardinality: arr.has('object') ? '1:N' : '1:1',
    status: 'suggested', confidence: scoreFrom(signals),
    detection: 'embedded',
    reason: `'${field.path}' looks like an embedded entity inside ${source.name}.`,
    signals, tags: [], createdAt: new Date(), updatedAt: new Date(),
  };
}

// ----- Orchestrator -------------------------------------------------------
const TOP_K_PER_FIELD = 3;
const NAME_SIM_CUTOFF = 0.5;
const MIN_CONFIDENCE  = 25;

export async function discoverRelationships(collections: IntelCollection[]): Promise<IntelRelationship[]> {
  const targets = buildTargetIndex(collections);
  const suffixes = inferSuffixes(collections);

  // Corpus-driven abbreviation map.
  const abbreviations = inferAbbreviations([
    ...collections.map(c => c.name),
    ...collections.flatMap(c => c.fields.map(f => f.path)),
  ]);
  const expand = (s: string): string[] => {
    const hit = abbreviations.get(s);
    return hit && hit !== s ? [s, hit] : [s];
  };

  const out = new Map<string, IntelRelationship>();
  for (const src of collections) {
    for (const field of src.fields) {
      if (field.path === '_id') continue;

      // 1) Embedded entity (cheap, local).
      const emb = tryEmbedded(src, field);
      if (emb && !out.has(emb.fingerprint)) out.set(emb.fingerprint, emb);

      // 2) Cross-collection reference. Derive a "stem" purely from name
      //    structure — no entity vocabulary.
      const fk = stemFromFieldName(field.path, suffixes);
      const stem = fk?.stem ?? '';
      const variants = new Set<string>();
      if (stem) for (const v of expand(stem)) variants.add(v);
      // Also try the bare last segment so fields like "owner" or "parent"
      // are evaluated against the corpus too.
      const last = field.path.split('.').pop() ?? '';
      if (last && (last !== '_id')) variants.add(last);

      if (!variants.size) continue;

      const scored: { tgt: TargetColl; nm: NameMatch }[] = [];
      for (const t of targets) {
        if (t.coll.name === src.name) continue;
        let best: NameMatch = { score: 0, evidence: [] };
        for (const v of variants) {
          const nm = nameSimilarity(v, t.coll.name);
          if (nm.score > best.score) best = nm;
        }
        if (best.score >= NAME_SIM_CUTOFF) scored.push({ tgt: t, nm: best });
      }
      scored.sort((a, b) => b.nm.score - a.nm.score);

      for (const { tgt, nm } of scored.slice(0, TOP_K_PER_FIELD)) {
        for (const tf of tgt.identifiers) {
          const rel = await evaluateCandidate(src, field, tgt, tf, nm);
          if (!rel || rel.confidence < MIN_CONFIDENCE) continue;
          const prev = out.get(rel.fingerprint);
          if (!prev || prev.confidence < rel.confidence) out.set(rel.fingerprint, rel);
        }
      }
    }
  }

  return [...out.values()].sort((a, b) => b.confidence - a.confidence);
}
