import crypto from 'node:crypto';
import { biDb } from './mongo';
import { env } from './env';
import { embed, cosineSim, isEmbeddingEnabled } from './embeddings';
import type { LlmReport } from './llm';

// Cached LLM answers. Schema version is derived from the schema digest's
// generatedAt timestamp so cached pipelines tied to an outdated schema can
// be ignored automatically when fields/collections change.
export interface CachedReport {
  questionKey: string;
  question: string;
  questionNorm: string;
  schemaVersion: string;
  model: string;
  collection: string;
  pipeline: Record<string, unknown>[];
  display: LlmReport['display'];
  explanation: string;
  warnings: string[];
  embedding: number[] | null;
  embeddingModel: string | null;
  hits: number;
  createdAt: Date;
  lastUsedAt: Date;
}

export interface CacheHit {
  report: LlmReport;
  matchType: 'exact' | 'semantic';
  similarity?: number;
  cachedAt: Date;
}

const COLL = 'report_cache';

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').replace(/[?!.]+$/g, '').trim();
}

function questionKey(qNorm: string, schemaVersion: string, model: string): string {
  return crypto.createHash('sha256').update(`${schemaVersion}|${model}|${qNorm}`).digest('hex');
}

async function ensureIndexes(): Promise<void> {
  const db = await biDb();
  const c = db.collection<CachedReport>(COLL);
  await c.createIndex({ questionKey: 1 }, { unique: true });
  await c.createIndex({ schemaVersion: 1, createdAt: -1 });
  await c.createIndex({ lastUsedAt: -1 });
}

function isExpired(d: Date): boolean {
  if (!env.CACHE_TTL_DAYS) return false;
  const ageMs = Date.now() - d.getTime();
  return ageMs > env.CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
}

function toReport(c: CachedReport): LlmReport {
  return {
    collection: c.collection,
    pipeline: c.pipeline,
    display: c.display,
    explanation: c.explanation,
    warnings: c.warnings,
  };
}

export async function lookup(question: string, schemaVersion: string, model: string): Promise<CacheHit | null> {
  await ensureIndexes();
  const db = await biDb();
  const c = db.collection<CachedReport>(COLL);
  const qNorm = normalizeQuestion(question);
  const key = questionKey(qNorm, schemaVersion, model);

  const exact = await c.findOne({ questionKey: key });
  if (exact && !isExpired(exact.createdAt)) {
    await c.updateOne({ questionKey: key }, { $inc: { hits: 1 }, $set: { lastUsedAt: new Date() } });
    return { report: toReport(exact), matchType: 'exact', cachedAt: exact.createdAt };
  }

  if (!isEmbeddingEnabled()) return null;
  const emb = await embed(question);
  if (!emb) return null;

  // Candidate set: same schema version, not expired, has embedding from the
  // same model. We score in-process — fine for cache sizes well into the tens
  // of thousands at this collection cardinality.
  const candidates = await c.find({
    schemaVersion,
    embeddingModel: emb.model,
    embedding: { $exists: true, $ne: null },
  }).sort({ createdAt: -1 }).limit(500).toArray();

  let best: { row: CachedReport; sim: number } | null = null;
  for (const row of candidates) {
    if (!row.embedding) continue;
    if (isExpired(row.createdAt)) continue;
    const s = cosineSim(emb.vector, row.embedding);
    if (!best || s > best.sim) best = { row, sim: s };
  }
  if (best && best.sim >= env.CACHE_SIMILARITY_THRESHOLD) {
    await c.updateOne(
      { questionKey: best.row.questionKey },
      { $inc: { hits: 1 }, $set: { lastUsedAt: new Date() } },
    );
    return { report: toReport(best.row), matchType: 'semantic', similarity: best.sim, cachedAt: best.row.createdAt };
  }
  return null;
}

export async function store(args: {
  question: string;
  schemaVersion: string;
  model: string;
  report: LlmReport;
}): Promise<void> {
  await ensureIndexes();
  const db = await biDb();
  const c = db.collection<CachedReport>(COLL);
  const qNorm = normalizeQuestion(args.question);
  const key = questionKey(qNorm, args.schemaVersion, args.model);
  const emb = isEmbeddingEnabled() ? await embed(args.question) : null;
  const now = new Date();

  await c.updateOne(
    { questionKey: key },
    {
      $setOnInsert: {
        questionKey: key,
        question: args.question,
        questionNorm: qNorm,
        schemaVersion: args.schemaVersion,
        model: args.model,
        collection: args.report.collection,
        pipeline: args.report.pipeline,
        display: args.report.display,
        explanation: args.report.explanation,
        warnings: args.report.warnings ?? [],
        embedding: emb?.vector ?? null,
        embeddingModel: emb?.model ?? null,
        hits: 0,
        createdAt: now,
      },
      $set: { lastUsedAt: now },
    },
    { upsert: true },
  );
}
