// Self-learning hooks. When a relationship is approved we remember the pattern
// so future analyses boost similar suggestions; when rejected we penalize.
import type { IntelRelationship } from './types';
import { intelLearning } from './storage';

function patternOf(r: Pick<IntelRelationship, 'source' | 'target' | 'type'>): string {
  return `${r.source.collection}.${r.source.field}->${r.target.collection}:${r.type}`;
}

export async function recordApproval(r: IntelRelationship, actor: string) {
  const coll = await intelLearning();
  const pat = patternOf(r);
  await coll.updateOne(
    { pattern: pat },
    {
      $set: { hint: `approved by ${actor}`, updatedAt: new Date() },
      $inc: { delta: 1, count: 1 },
    },
    { upsert: true },
  );
}

export async function recordRejection(r: IntelRelationship, actor: string) {
  const coll = await intelLearning();
  const pat = patternOf(r);
  await coll.updateOne(
    { pattern: pat },
    {
      $set: { hint: `rejected by ${actor}`, updatedAt: new Date() },
      $inc: { delta: -1, count: 1 },
    },
    { upsert: true },
  );
}
