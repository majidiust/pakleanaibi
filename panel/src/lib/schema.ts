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

// Drops the cached digest so the next getSchema() call resamples and picks up
// freshly-added/edited/removed relationships. Called from the intel
// relationship mutation routes so analysts don't have to wait out the 30-min
// TTL to see new JOIN RECIPES surface in the agentic prompt.
export async function invalidateSchemaCache(): Promise<void> {
  try {
    const bi = await biDb();
    await bi.collection('schema_cache').deleteOne({ key: 'data' });
  } catch { /* best-effort */ }
}

// True when a string value looks like a serialized date. Date-stored-as-string
// is a common pattern in legacy collections and produces silent zero-row
// matches when compared as a BSON Date with {"$date": ...} — surfacing the
// example lets the model spot the mismatch and switch to $toDate / regex.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function looksLikeDateString(v: unknown): boolean {
  return typeof v === 'string' && v.length >= 8 && v.length <= 40 && ISO_DATE_RE.test(v);
}
function looksLikeMillisNumber(v: unknown): boolean {
  // Millis since epoch from year 2000 onward, capped at year 2200 to avoid
  // misclassifying ordinary id / count / amount values.
  return typeof v === 'number' && Number.isInteger(v) && v >= 946_684_800_000 && v <= 7_258_118_400_000;
}

// Compact rendering of an example value for the schema prompt. Keeps the
// payload small (LLM context budget) while preserving enough shape for the
// model to recognise BSON Date vs ISO-string vs numeric-millis storage.
function formatExample(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const bsonType = (v as { _bsontype?: string })._bsontype;
  if (bsonType === 'ObjectId') return `ObjectId("${String(v)}")`;
  if (typeof v === 'string') return v.length > 60 ? JSON.stringify(v.slice(0, 60) + '…') : JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null; // skip arrays/objects — too noisy for the prompt
}

// True when the field is plausibly a timestamp the model might filter on,
// either by declared BSON type, by name hint, or by example shape.
const DATE_NAME_RE = /^(d|dt)?(create|update|modif|delete|edit|publish|expire|order|complete|finish|start|end|sent|received|read|seen|login|signup|register|paid|refund|ship|deliver)/i;
const DATE_SUFFIX_RE = /(date|time|at|on|when|stamp|ts)$/i;
function isDateLikeField(name: string, types: string[], example: unknown): boolean {
  if (types.includes('date')) return true;
  if (DATE_NAME_RE.test(name) || DATE_SUFFIX_RE.test(name)) return true;
  if (looksLikeDateString(example) || looksLikeMillisNumber(example)) return true;
  return false;
}

// Compact text form used inside the LLM system prompt. We list collections
// with their fields and -- crucially -- a JOIN RECIPES section that spells
// out ready-to-paste $lookup stages in BOTH directions for every
// human-confirmed relationship. The model otherwise tends to invert the
// natural anchor when the user phrases a question around the "many" side
// (e.g. "items of the last order") and produce N x M lookups that
// inevitably time out.
//
// `opts.mode`:
//   'full'    : verbose join recipes (full $lookup JSON, forward+reverse, chains)
//   'compact' : one-line relationships only, no chained-join templates, terse
//               field rendering. Saves ~70-90% of tokens on a large schema.
// `opts.keepCollections`: when set, only collections whose name is in this set
//   are listed (used by the budget-aware caller to hide low-signal collections).
export interface SchemaPromptOpts {
  mode?: 'full' | 'compact';
  keepCollections?: Set<string>;
}
export function schemaToPrompt(s: SchemaDigest, opts: SchemaPromptOpts = {}): string {
  const mode = opts.mode ?? 'full';
  const keep = opts.keepCollections;
  const lines: string[] = [`Database: ${s.database}`, `Collections (sorted by row count):`];
  for (const c of s.collections) {
    if (keep && !keep.has(c.name)) continue;
    const fields = c.fields.map(f => {
      // Annotate the type tag with a storage hint for fields that the model
      // is likely to filter on (date columns and _id ObjectIds). The hint is
      // derived from the actual sampled value so a date-stored-as-string is
      // visibly distinguished from a real BSON Date.
      const dateLike = isDateLikeField(f.name, f.types, f.example);
      // Compact mode: single dominant type, single-letter code; full mode keeps
      // the human-readable union. Both modes still emit the !bsonDate / !dateString
      // / !millis storage hint for date-shaped fields.
      let typeTag: string;
      if (mode === 'compact') {
        const t = f.types[0] ?? '?';
        typeTag = ({ string: 's', number: 'n', boolean: 'b', date: 'd', objectId: 'o', array: 'a', object: 'O', null: 'z' } as Record<string, string>)[t] ?? '?';
      } else {
        typeTag = f.types.join('|');
      }
      if (dateLike) {
        if (f.types.includes('date')) typeTag += '!bsonDate';
        else if (looksLikeDateString(f.example)) typeTag += '!dateString';
        else if (looksLikeMillisNumber(f.example)) typeTag += '!millis';
      }
      const ex = formatExample(f.example);
      // Surface examples for date-like fields and the canonical _id ObjectId
      // (so the model is reminded it can extract a creation timestamp from
      // an _id without a dedicated date column). Other fields keep the
      // existing terse `name:type` form so the digest stays compact.
      const showExample = ex && (dateLike || f.name === '_id');
      return showExample ? `${f.name}:${typeTag}=${ex}` : `${f.name}:${typeTag}`;
    }).join(', ');
    lines.push(`- ${c.name} (~${c.count} docs): ${fields}`);
  }
  const allRels = s.relationships ?? [];
  // When some collections are hidden, drop relationships whose endpoints are no
  // longer listed -- otherwise the model would see joins pointing at unlisted
  // collections and get confused.
  const rels = keep
    ? allRels.filter(r => keep.has(r.source.collection) && keep.has(r.target.collection))
    : allRels;
  if (rels.length) {
    lines.push('', 'Known relationships (human-confirmed; safe to use for $lookup joins):');
    for (const r of rels) {
      const tgt = r.target.matchOn ? `${r.target.collection}.${r.target.matchOn}` : `${r.target.collection}.${r.target.field}`;
      const card = r.cardinality ? ` [${r.cardinality}]` : '';
      lines.push(`- ${r.source.collection}.${r.source.field} -> ${tgt} (${r.type}${card}, ${r.status})`);
    }
    if (mode === 'full') {
      // Join recipes: for each relationship, emit the forward and reverse
      // $lookup templates explicitly. The model can pick either side as the
      // anchor depending on which collection the request is "about" -- the
      // PIPELINE PLANNING rules above tell it to anchor where the filters
      // are most selective.
      lines.push('', 'JOIN RECIPES (use these exact $lookup shapes; do NOT invent join keys):');
      for (const r of rels) {
        const tgtKey = r.target.matchOn ?? r.target.field;
        // Forward: anchor in source, enrich each row with the target.
        lines.push(
          `- Anchor in "${r.source.collection}", attach matching "${r.target.collection}":\n` +
          `    { "$lookup": { "from": "${r.target.collection}", "localField": "${r.source.field}", "foreignField": "${tgtKey}", "as": "${r.target.collection}_joined" } }`,
        );
        // Reverse: anchor in target, attach the many "source" rows.
        lines.push(
          `- Anchor in "${r.target.collection}", attach matching "${r.source.collection}":\n` +
          `    { "$lookup": { "from": "${r.source.collection}", "localField": "${tgtKey}", "foreignField": "${r.source.field}", "as": "${r.source.collection}_joined" } }`,
        );
      }
      // Multi-hop chain recipes. When the user asks for a field that lives two
      // collections away from the natural anchor (classic case: "items of the
      // last order with the item NAME" -- name is in `items`, not `orderitems`),
      // the model often stops at the first $lookup. Emitting full chain
      // templates (anchor -> $lookup -> $unwind -> $lookup) tells it the exact
      // sequence of stages required to surface fields on the far side.
      const chains = buildChains(rels);
      if (chains.length) {
        lines.push('', 'CHAINED JOIN RECIPES (use when a requested field is two hops away from the anchor):');
        for (const c of chains) lines.push(c);
      }
    } else {
      // Compact mode: a single rule line tells the model how to construct a
      // $lookup from a relationship entry. Saves ~80% of the JOIN RECIPES
      // section without losing information -- the model already knows the
      // $lookup shape, it just needs the keys, which are in the relationships
      // list above.
      lines.push(
        '',
        'JOIN RULE: for each relationship "A.fa -> B.fb", build $lookup as',
        '  { "$lookup": { "from": "B", "localField": "fa", "foreignField": "fb", "as": "B_joined" } }',
        '  Reverse direction: swap A<->B and fa<->fb. Follow with',
        '  { "$unwind": { "path": "$B_joined", "preserveNullAndEmptyArrays": true } }',
        '  for 1:1 / N:1 sides. Chain multiple lookups to reach 2-hop fields.',
      );
    }
  }
  return lines.join('\n');
}

// Build a schema prompt that fits within a token budget. Tries (in order):
//   1. full mode with all collections
//   2. compact mode with all collections
//   3. compact mode, dropping low-signal collections (no relationships AND
//      below an adaptive row-count threshold) until under budget.
// Returns the prompt plus a short diagnostic about what was downgraded so
// the caller can surface it (and optionally tell the LLM that some
// collections were hidden this turn).
const ASCII_TOKEN_RATIO = 3; // tokens per UTF-8 byte; same heuristic as llm.ts
function approxTokens(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  return Math.ceil(bytes / ASCII_TOKEN_RATIO);
}
export interface FittedSchemaPrompt {
  prompt: string;
  mode: 'full' | 'compact';
  hiddenCollections: string[];
  estimatedTokens: number;
}
export function fitSchemaPrompt(s: SchemaDigest, budgetTokens: number): FittedSchemaPrompt {
  const full = schemaToPrompt(s, { mode: 'full' });
  if (approxTokens(full) <= budgetTokens) {
    return { prompt: full, mode: 'full', hiddenCollections: [], estimatedTokens: approxTokens(full) };
  }
  const compact = schemaToPrompt(s, { mode: 'compact' });
  if (approxTokens(compact) <= budgetTokens) {
    return { prompt: compact, mode: 'compact', hiddenCollections: [], estimatedTokens: approxTokens(compact) };
  }
  // Drop low-signal collections. Score = (in any relationship ? 1e12 : 0) + count.
  // Collections that participate in a relationship are always kept; among the
  // rest, the highest-row-count survive longest.
  const rels = s.relationships ?? [];
  const inRel = new Set<string>();
  for (const r of rels) { inRel.add(r.source.collection); inRel.add(r.target.collection); }
  const ranked = [...s.collections].sort((a, b) => {
    const sa = (inRel.has(a.name) ? 1e12 : 0) + a.count;
    const sb = (inRel.has(b.name) ? 1e12 : 0) + b.count;
    return sb - sa;
  });
  const kept = new Set(ranked.map(c => c.name));
  const hidden: string[] = [];
  // Drop one collection at a time from the tail until under budget. O(n) shrinks
  // is fine: schemas with hundreds of collections are still tractable.
  for (let i = ranked.length - 1; i >= 0; i--) {
    const out = schemaToPrompt(s, { mode: 'compact', keepCollections: kept });
    if (approxTokens(out) <= budgetTokens) {
      return { prompt: out, mode: 'compact', hiddenCollections: hidden, estimatedTokens: approxTokens(out) };
    }
    const drop = ranked[i].name;
    if (inRel.has(drop) && kept.size > 5) {
      // Last resort: even relationship-bearing collections must yield. Stop
      // the "always keep" rule and continue trimming.
    }
    kept.delete(drop);
    hidden.push(drop);
    if (kept.size <= 1) break;
  }
  const out = schemaToPrompt(s, { mode: 'compact', keepCollections: kept });
  return { prompt: out, mode: 'compact', hiddenCollections: hidden, estimatedTokens: approxTokens(out) };
}

interface Edge { from: string; fromField: string; to: string; toField: string }

// Walks all approved/manual relationships and emits human-readable templates
// for every 2-hop path A -> B -> C (and its reverse). Each template includes
// the exact $lookup / $unwind / $lookup sequence so the agent has nothing
// left to invent when chaining joins.
function buildChains(rels: KnownRelationship[]): string[] {
  const edges: Edge[] = [];
  for (const r of rels) {
    const toField = r.target.matchOn ?? r.target.field;
    edges.push({ from: r.source.collection, fromField: r.source.field, to: r.target.collection, toField });
    edges.push({ from: r.target.collection, fromField: toField, to: r.source.collection, toField: r.source.field });
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e1 of edges) {
    for (const e2 of edges) {
      if (e1.to !== e2.from) continue;
      if (e1.from === e2.to) continue; // skip A->B->A loops
      const key = `${e1.from}|${e1.fromField}|${e1.to}|${e2.to}|${e2.toField}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const midAs = `${e1.to}_joined`;
      const farAs = `${e2.to}_joined`;
      out.push(
        `- Anchor in "${e1.from}" -> attach "${e1.to}" -> attach "${e2.to}" (use when a field on "${e2.to}" is requested):\n` +
        `    { "$lookup": { "from": "${e1.to}", "localField": "${e1.fromField}", "foreignField": "${e1.toField}", "as": "${midAs}" } }\n` +
        `    { "$unwind": { "path": "$${midAs}", "preserveNullAndEmptyArrays": true } }\n` +
        `    { "$lookup": { "from": "${e2.to}", "localField": "${midAs}.${e2.fromField}", "foreignField": "${e2.toField}", "as": "${farAs}" } }\n` +
        `    { "$unwind": { "path": "$${farAs}", "preserveNullAndEmptyArrays": true } }`,
      );
    }
  }
  return out;
}
