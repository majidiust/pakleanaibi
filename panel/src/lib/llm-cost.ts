import { biDb } from './mongo';

// USD per 1M tokens, [input, output]. Output is 0 for embeddings (no output
// tokens). Unknown models fall back to [0, 0] -- we still record the call so
// the user sees it in the dashboard, but the cost line stays at zero until a
// matching entry is added here.
const PRICING: Record<string, [number, number]> = {
  'gpt-4o-mini':            [0.15, 0.60],
  'gpt-4o':                 [2.50, 10.00],
  'gpt-4-turbo':            [10.00, 30.00],
  'gpt-4':                  [30.00, 60.00],
  'gpt-3.5-turbo':          [0.50, 1.50],
  'gpt-4.1':                [2.00, 8.00],
  'gpt-4.1-mini':           [0.40, 1.60],
  'gpt-4.1-nano':           [0.10, 0.40],
  'o1':                     [15.00, 60.00],
  'o1-preview':             [15.00, 60.00],
  'o1-mini':                [3.00, 12.00],
  'o3':                     [2.00, 8.00],
  'o3-mini':                [1.10, 4.40],
  'o4-mini':                [1.10, 4.40],
  'text-embedding-3-small': [0.02, 0],
  'text-embedding-3-large': [0.13, 0],
  'text-embedding-ada-002': [0.10, 0],
};

function pricingFor(model: string): [number, number] {
  if (PRICING[model]) return PRICING[model];
  // OpenAI often returns dated variants like "gpt-4o-mini-2024-07-18". Strip
  // tail segments until we find a known root, so a new dated release inherits
  // its family's pricing automatically.
  const parts = model.split('-');
  for (let n = parts.length - 1; n >= 2; n--) {
    const key = parts.slice(0, n).join('-');
    if (PRICING[key]) return PRICING[key];
  }
  return [0, 0];
}

export function computeCost(model: string, prompt: number, completion: number): number {
  const [pIn, pOut] = pricingFor(model);
  return (prompt * pIn + completion * pOut) / 1_000_000;
}

export interface RecordUsageInput {
  op: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  durationMs?: number;
}

// Fire-and-forget. Telemetry must never block the LLM path or surface an error
// to the caller, so the insert runs in a detached promise with a swallowed
// catch. We still await the biDb() handle so a misconfigured connection logs
// once via console.warn instead of producing an unhandled rejection.
export async function recordUsage(u: RecordUsageInput): Promise<void> {
  try {
    const cost = computeCost(u.model, u.promptTokens, u.completionTokens);
    const db = await biDb();
    await db.collection('llm_usage').insertOne({
      op: u.op,
      model: u.model,
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      totalTokens: u.promptTokens + u.completionTokens,
      costUsd: cost,
      durationMs: u.durationMs,
      ts: new Date(),
    });
  } catch (e) {
    console.warn('[llm-cost] recordUsage failed:', e instanceof Error ? e.message : e);
  }
}

export interface UsageBucket { calls: number; tokens: number; costUsd: number }
export interface UsageSummary {
  totals: UsageBucket;
  today: UsageBucket;
  month: UsageBucket;
  byOp: { op: string; calls: number; tokens: number; costUsd: number }[];
  byModel: { model: string; calls: number; tokens: number; costUsd: number }[];
  recent: { ts: Date; op: string; model: string; totalTokens: number; costUsd: number }[];
}

const EMPTY: UsageBucket = { calls: 0, tokens: 0, costUsd: 0 };

function bucketize(rows: { calls: number; tokens: number; costUsd: number }[]): UsageBucket {
  const r = rows[0];
  return r ? { calls: r.calls, tokens: r.tokens, costUsd: r.costUsd } : EMPTY;
}

export async function getUsageSummary(): Promise<UsageSummary> {
  const db = await biDb();
  const col = db.collection('llm_usage');
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const sumGroup = { _id: null, calls: { $sum: 1 }, tokens: { $sum: '$totalTokens' }, costUsd: { $sum: '$costUsd' } };
  const groupBy = (key: '$op' | '$model') => [
    { $group: { _id: key, calls: { $sum: 1 }, tokens: { $sum: '$totalTokens' }, costUsd: { $sum: '$costUsd' } } },
    { $sort: { costUsd: -1 } },
    { $limit: 8 },
  ];
  const [totalsAgg, todayAgg, monthAgg, byOpAgg, byModelAgg, recentDocs] = await Promise.all([
    col.aggregate<{ calls: number; tokens: number; costUsd: number }>([{ $group: sumGroup }]).toArray(),
    col.aggregate<{ calls: number; tokens: number; costUsd: number }>([{ $match: { ts: { $gte: startOfDay } } }, { $group: sumGroup }]).toArray(),
    col.aggregate<{ calls: number; tokens: number; costUsd: number }>([{ $match: { ts: { $gte: startOfMonth } } }, { $group: sumGroup }]).toArray(),
    col.aggregate<{ _id: string; calls: number; tokens: number; costUsd: number }>(groupBy('$op')).toArray(),
    col.aggregate<{ _id: string; calls: number; tokens: number; costUsd: number }>(groupBy('$model')).toArray(),
    col.find({}, { projection: { ts: 1, op: 1, model: 1, totalTokens: 1, costUsd: 1 } }).sort({ ts: -1 }).limit(8).toArray(),
  ]);
  return {
    totals: bucketize(totalsAgg),
    today: bucketize(todayAgg),
    month: bucketize(monthAgg),
    byOp: byOpAgg.map(d => ({ op: d._id ?? 'unknown', calls: d.calls, tokens: d.tokens, costUsd: d.costUsd })),
    byModel: byModelAgg.map(d => ({ model: d._id ?? 'unknown', calls: d.calls, tokens: d.tokens, costUsd: d.costUsd })),
    recent: recentDocs.map(d => ({
      ts: d.ts as Date,
      op: String(d.op ?? ''),
      model: String(d.model ?? ''),
      totalTokens: Number(d.totalTokens ?? 0),
      costUsd: Number(d.costUsd ?? 0),
    })),
  };
}
