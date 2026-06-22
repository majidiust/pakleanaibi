import { biDb, dataDb } from './mongo';

// Builds a compact digest of the data DB schema by sampling each collection.
// Result is small enough to fit in the LLM context window and is cached in the
// BI DB with a TTL so frequent reports don't re-sample huge collections.
export interface FieldInfo { name: string; types: string[]; example?: unknown }
export interface CollectionInfo {
  name: string;
  count: number;
  fields: FieldInfo[];
}
export interface KnownRelationship {
  source: { collection: string; field: string };
  target: { collection: string; field: string; matchOn?: string };
  type: string;
  cardinality?: string;
  status: 'approved' | 'manual';
}
export interface SchemaDigest {
  database: string;
  collections: CollectionInfo[];
  relationships?: KnownRelationship[];
  generatedAt: string;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min
const SAMPLE_SIZE = 25;
const MAX_FIELDS_PER_COLL = 40;

function classify(v: unknown): string {
  if (v === null) return 'null';
  if (v instanceof Date) return 'date';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object' && (v as { _bsontype?: string })._bsontype === 'ObjectId') return 'objectId';
  return typeof v;
}

async function sampleCollection(name: string): Promise<CollectionInfo> {
  const db = await dataDb();
  const coll = db.collection(name);
  const [count, docs] = await Promise.all([
    coll.estimatedDocumentCount(),
    coll.aggregate([{ $sample: { size: SAMPLE_SIZE } }], { maxTimeMS: 5000 }).toArray(),
  ]);
  const fields = new Map<string, { types: Set<string>; example: unknown }>();
  for (const d of docs) {
    for (const [k, v] of Object.entries(d)) {
      const f = fields.get(k) ?? { types: new Set<string>(), example: v };
      f.types.add(classify(v));
      fields.set(k, f);
    }
  }
  const list: FieldInfo[] = [...fields.entries()]
    .slice(0, MAX_FIELDS_PER_COLL)
    .map(([name, info]) => ({ name, types: [...info.types], example: info.example }));
  return { name, count, fields: list };
}

export async function getSchema(force = false): Promise<SchemaDigest> {
  const bi = await biDb();
  const cache = bi.collection<{ key: string; digest: SchemaDigest; expiresAt: Date }>('schema_cache');
  if (!force) {
    const hit = await cache.findOne({ key: 'data' });
    if (hit && hit.expiresAt > new Date()) return hit.digest;
  }
  const db = await dataDb();
  const colls = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map(c => c.name)
    .filter(n => !n.startsWith('system.') && !n.startsWith('_sync_state'));
  const infos: CollectionInfo[] = [];
  for (const name of colls) {
    try { infos.push(await sampleCollection(name)); }
    catch { /* skip unreadable */ }
  }
  // Pull only relationships that a human approved or created. Suggested /
  // weak / rejected ones are intentionally withheld from the LLM so the
  // model never invents joins from low-confidence guesses.
  const relColl = bi.collection<{
    source: { collection: string; field: string };
    target: { collection: string; field: string; matchOn?: string };
    type: string; cardinality?: string; status: string;
  }>('intel_relationships');
  const known = await relColl.find(
    { status: { $in: ['approved', 'manual'] } },
    { projection: { _id: 0, source: 1, target: 1, type: 1, cardinality: 1, status: 1 } },
  ).toArray().catch(() => []);

  const digest: SchemaDigest = {
    database: db.databaseName,
    collections: infos.sort((a, b) => b.count - a.count),
    relationships: known as KnownRelationship[],
    generatedAt: new Date().toISOString(),
  };
  await cache.updateOne(
    { key: 'data' },
    { $set: { key: 'data', digest, expiresAt: new Date(Date.now() + CACHE_TTL_MS) } },
    { upsert: true },
  );
  return digest;
}

// Compact text form used inside the LLM system prompt.
export function schemaToPrompt(s: SchemaDigest): string {
  const lines: string[] = [`Database: ${s.database}`, `Collections (sorted by row count):`];
  for (const c of s.collections) {
    const fields = c.fields.map(f => `${f.name}:${f.types.join('|')}`).join(', ');
    lines.push(`- ${c.name} (~${c.count} docs): ${fields}`);
  }
  const rels = s.relationships ?? [];
  if (rels.length) {
    lines.push('', 'Known relationships (human-confirmed; safe to use for $lookup joins):');
    for (const r of rels) {
      const tgt = r.target.matchOn ? `${r.target.collection}.${r.target.matchOn}` : `${r.target.collection}.${r.target.field}`;
      const card = r.cardinality ? ` [${r.cardinality}]` : '';
      lines.push(`- ${r.source.collection}.${r.source.field} -> ${tgt} (${r.type}${card}, ${r.status})`);
    }
  }
  return lines.join('\n');
}
