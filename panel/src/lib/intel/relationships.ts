// Relationship discovery. Operates exclusively on the metadata produced by
// discover.ts plus optional value-level validation against the data DB.
import { ObjectId } from 'mongodb';
import { dataDb } from '../mongo';
import type {
  IntelCollection, IntelRelationship, RelationshipType,
  DetectionMethod, FieldSample,
} from './types';
import { intelLearning } from './storage';

// Common soft-relationship keys -> target field on the destination side.
const SOFT_KEYS: { field: RegExp; matchOn: string; entity: RegExp }[] = [
  { field: /^email$|\.email$/, matchOn: 'email', entity: /user|account|member/i },
  { field: /^slug$|\.slug$/,    matchOn: 'slug',  entity: /store|shop|product|business/i },
  { field: /^username$|\.username$/, matchOn: 'username', entity: /user|account/i },
  { field: /^phone$|\.phone$|^mobile$/, matchOn: 'phone', entity: /user|account|customer/i },
  { field: /externalpaymentid$/i, matchOn: 'externalPaymentId', entity: /payment|transaction/i },
];

function fingerprint(r: Pick<IntelRelationship, 'source' | 'target' | 'type'>): string {
  return [
    r.source.collection, r.source.field,
    r.target.collection, r.target.field, r.type,
  ].join('::');
}

// Derive a candidate target collection name from a field like "userId" / "user_id"
// / "user.ref" / "userRef". Returns the singular stem.
function stemFromForeignKey(path: string): string | null {
  const last = path.split('.').pop()!;
  // userId, user_id, userRef, userOid
  const m = last.match(/^([a-zA-Z][a-zA-Z0-9]*?)(?:_)?(?:id|oid|ref|_ref)$/i);
  if (!m) return null;
  let stem = m[1];
  if (stem.length < 2) return null;
  // Camel -> lower for matching
  return stem.charAt(0).toLowerCase() + stem.slice(1);
}

// Build a name index for the available collections to make lookup tolerant
// of pluralisation and casing differences.
function buildNameIndex(collections: IntelCollection[]) {
  const exact = new Map<string, IntelCollection>();
  const stems = new Map<string, IntelCollection[]>();
  for (const c of collections) {
    exact.set(c.name.toLowerCase(), c);
    const stem = singularize(c.name).toLowerCase();
    const arr = stems.get(stem) ?? [];
    arr.push(c);
    stems.set(stem, arr);
  }
  return { exact, stems };
}

function singularize(n: string): string {
  if (/ies$/.test(n)) return n.replace(/ies$/, 'y');
  if (/sses$/.test(n)) return n.replace(/es$/, '');
  if (/s$/.test(n) && !/ss$/.test(n)) return n.replace(/s$/, '');
  return n;
}

function findTarget(stem: string, idx: ReturnType<typeof buildNameIndex>): IntelCollection | null {
  const lower = stem.toLowerCase();
  return idx.exact.get(lower)
      ?? idx.exact.get(lower + 's')
      ?? idx.exact.get(lower + 'es')
      ?? idx.stems.get(lower)?.[0]
      ?? null;
}

interface Signal { label: string; weight: number; note?: string }

async function validateObjectIdRef(
  source: IntelCollection, field: FieldSample, target: IntelCollection,
): Promise<{ matched: number; checked: number }> {
  // Take the first few example values and probe whether they exist in target._id.
  const candidates: ObjectId[] = [];
  for (const ex of field.examples) {
    if (ex instanceof ObjectId) candidates.push(ex);
    else if (typeof ex === 'string' && /^[0-9a-fA-F]{24}$/.test(ex)) {
      try { candidates.push(new ObjectId(ex)); } catch { /* ignore */ }
    }
    if (candidates.length >= 5) break;
  }
  if (candidates.length === 0) return { matched: 0, checked: 0 };
  const db = await dataDb();
  const found = await db.collection(target.name)
    .countDocuments({ _id: { $in: candidates } }, { limit: candidates.length });
  return { matched: found, checked: candidates.length };
}

async function validateSoftRef(
  field: FieldSample, target: IntelCollection, matchOn: string,
): Promise<{ matched: number; checked: number }> {
  const values = field.examples
    .filter(v => v !== null && v !== undefined && typeof v !== 'object')
    .slice(0, 5);
  if (values.length === 0) return { matched: 0, checked: 0 };
  const db = await dataDb();
  const found = await db.collection(target.name)
    .countDocuments({ [matchOn]: { $in: values } }, { limit: values.length });
  return { matched: found, checked: values.length };
}

function cardinalityFor(source: FieldSample): '1:1' | 'N:1' {
  // If the source field is highly unique it's likely 1:1; otherwise N:1.
  return source.uniqueness > 0.9 ? '1:1' : 'N:1';
}

function scoreFrom(signals: Signal[]): number {
  // Weights sum into a 0-100 score, clamped.
  const total = signals.reduce((a, s) => a + s.weight, 0);
  return Math.max(0, Math.min(100, Math.round(total)));
}

// Apply learned biases stored in intel_learning. Patterns are matched on a
// stable signature so the same (sourceColl, sourceField->targetColl, type)
// triple gets the same bias as it did when last reviewed.
async function applyLearning(rel: Pick<IntelRelationship, 'source' | 'target' | 'type'>, signals: Signal[]) {
  const coll = await intelLearning();
  const pat = `${rel.source.collection}.${rel.source.field}->${rel.target.collection}:${rel.type}`;
  const hit = await coll.findOne({ pattern: pat });
  if (hit) signals.push({ label: hit.delta > 0 ? 'previously approved pattern' : 'previously rejected pattern',
    weight: hit.delta * 15, note: hit.hint });
}

async function trySoftRefs(source: IntelCollection, field: FieldSample, collections: IntelCollection[]):
  Promise<IntelRelationship | null> {
  for (const k of SOFT_KEYS) {
    if (!k.field.test(field.path)) continue;
    // Find a target collection whose entity tag / name matches and has the matchOn field.
    const target = collections.find(c =>
      k.entity.test(c.name) && c.fields.some(f => f.path === k.matchOn));
    if (!target || target.name === source.name) continue;
    const sig: Signal[] = [
      { label: `field name matches soft key /${k.field.source}/`, weight: 35 },
      { label: `target collection ${target.name} has field ${k.matchOn}`, weight: 25 },
    ];
    const v = await validateSoftRef(field, target, k.matchOn).catch(() => ({ matched: 0, checked: 0 }));
    if (v.checked) sig.push({
      label: `${v.matched}/${v.checked} example values exist in target`,
      weight: (v.matched / v.checked) * 30, note: 'value-level validation',
    });
    const type: RelationshipType = 'soft';
    const rel: IntelRelationship = {
      fingerprint: fingerprint({ source: { collection: source.name, field: field.path },
                                  target: { collection: target.name, field: '_id', matchOn: k.matchOn }, type }),
      source: { collection: source.name, field: field.path },
      target: { collection: target.name, field: '_id', matchOn: k.matchOn },
      type, cardinality: cardinalityFor(field),
      status: 'suggested',
      confidence: 0, detection: 'soft-name', reason: '', signals: sig,
      tags: [], createdAt: new Date(), updatedAt: new Date(),
    };
    await applyLearning(rel, sig);
    rel.confidence = scoreFrom(sig);
    rel.reason = `Soft key '${field.path}' matches '${k.matchOn}' on ${target.name}.`;
    return rel;
  }
  return null;
}

async function tryEmbedded(source: IntelCollection, field: FieldSample): Promise<IntelRelationship | null> {
  // Heuristic embedded relationship: a field is an object/array of objects
  // with its own _id-like structure. The "target" is conceptual (the embedded
  // shape lives inside the source). Reported as type=embedded.
  const isEmbeddedObj = field.types.includes('object') || (field.arrayOf?.includes('object') ?? false);
  if (!isEmbeddedObj) return null;
  // Avoid the trivial cases where the doc has a sub-object that is not a list of entities.
  if (!source.fields.some(f => f.path.startsWith(field.path + '.') && /_id|id$/i.test(f.path))) return null;
  const sig: Signal[] = [
    { label: 'embedded object structure detected', weight: 60 },
    { label: 'sub-document has its own id-like field', weight: 25 },
  ];
  const type: RelationshipType = 'embedded';
  return {
    fingerprint: fingerprint({ source: { collection: source.name, field: field.path },
                                target: { collection: source.name, field: field.path }, type }),
    source: { collection: source.name, field: field.path },
    target: { collection: source.name, field: field.path },
    type, cardinality: field.arrayOf ? '1:N' : '1:1',
    status: 'suggested', confidence: scoreFrom(sig), detection: 'embedded',
    reason: `'${field.path}' looks like an embedded entity inside ${source.name}.`,
    signals: sig, tags: [], createdAt: new Date(), updatedAt: new Date(),
  };
}

async function tryObjectIdRef(
  source: IntelCollection, field: FieldSample, collections: IntelCollection[],
  nameIdx: ReturnType<typeof buildNameIndex>,
): Promise<IntelRelationship | null> {
  const types = new Set(field.types);
  const isOid = types.has('objectId') || (types.has('string') && field.looksLikeObjectIdString);
  if (!isOid) return null;
  const stem = stemFromForeignKey(field.path);
  if (!stem) return null;
  const target = findTarget(stem, nameIdx);
  if (!target || target.name === source.name) return null;
  const sig: Signal[] = [
    { label: 'field name matches foreign-key pattern', weight: 25, note: stem },
    { label: 'value type is ObjectId or 24-hex string', weight: 25 },
    { label: `name stem resolves to collection ${target.name}`, weight: 20 },
  ];
  const v = await validateObjectIdRef(source, field, target).catch(() => ({ matched: 0, checked: 0 }));
  if (v.checked) sig.push({
    label: `${v.matched}/${v.checked} example ObjectIds exist in ${target.name}._id`,
    weight: (v.matched / v.checked) * 30, note: 'value-level validation',
  });
  const detection: DetectionMethod = types.has('objectId') ? 'objectId-naming' : 'soft-value';
  const type: RelationshipType = 'many-to-one';
  const rel: IntelRelationship = {
    fingerprint: fingerprint({ source: { collection: source.name, field: field.path },
                                target: { collection: target.name, field: '_id' }, type }),
    source: { collection: source.name, field: field.path },
    target: { collection: target.name, field: '_id' },
    type, cardinality: cardinalityFor(field),
    status: 'suggested', confidence: 0, detection,
    reason: '', signals: sig, tags: [],
    createdAt: new Date(), updatedAt: new Date(),
  };
  await applyLearning(rel, sig);
  rel.confidence = scoreFrom(sig);
  rel.reason = `Field '${field.path}' (${[...types].join('|')}) -> ${target.name}._id.`;
  return rel;
}

export async function discoverRelationships(collections: IntelCollection[]): Promise<IntelRelationship[]> {
  const out = new Map<string, IntelRelationship>();
  const idx = buildNameIndex(collections);
  for (const src of collections) {
    for (const field of src.fields) {
      if (field.path === '_id') continue;
      // 1) ObjectId / hex foreign-key reference.
      const oid = await tryObjectIdRef(src, field, collections, idx);
      if (oid) out.set(oid.fingerprint, oid);
      // 2) Soft / domain-known reference (email, slug, ...).
      const soft = await trySoftRefs(src, field, collections);
      if (soft && !out.has(soft.fingerprint)) out.set(soft.fingerprint, soft);
      // 3) Embedded entity.
      const emb = await tryEmbedded(src, field);
      if (emb && !out.has(emb.fingerprint)) out.set(emb.fingerprint, emb);
    }
  }
  return [...out.values()].sort((a, b) => b.confidence - a.confidence);
}

export function relFingerprint(r: Pick<IntelRelationship, 'source' | 'target' | 'type'>): string {
  return fingerprint(r);
}
