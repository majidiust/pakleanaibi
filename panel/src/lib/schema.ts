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
export interface SchemaDigest {
  database: string;
  collections: CollectionInfo[];
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
  const digest: SchemaDigest = {
    database: db.databaseName,
    collections: infos.sort((a, b) => b.count - a.count),
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
  return lines.join('\n');
}
