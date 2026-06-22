import { biDb } from './mongo';
import { hashPassword } from './auth';
import { env } from './env';

// Idempotent: ensures the BI metadata DB has the indexes and the seeded admin
// user. Triggered lazily on first auth-related request rather than at process
// start to keep cold-boot fast and resilient if Mongo is briefly unavailable.
declare global {
  // eslint-disable-next-line no-var
  var __paklean_bootstrap_done: boolean | undefined;
}

export async function ensureBootstrap(): Promise<void> {
  if (global.__paklean_bootstrap_done) return;
  const db = await biDb();
  const users = db.collection('users');
  await users.createIndex({ email: 1 }, { unique: true });
  await db.collection('schema_cache').createIndex({ key: 1 }, { unique: true });
  await db.collection('reports').createIndex({ createdAt: -1 });
  // LLM usage ledger: dashboard reads recent-by-ts and groups by op / model,
  // so a descending ts index covers the recents query and a (op, ts) index
  // keeps the per-op aggregation cheap once the collection grows large.
  await db.collection('llm_usage').createIndex({ ts: -1 });
  await db.collection('llm_usage').createIndex({ op: 1, ts: -1 });
  // Agentic chat persistence: every user's conversation list is fetched
  // ordered by updatedAt desc, so a compound (userId, updatedAt) index covers
  // the common query without a separate sort stage.
  await db.collection('agentic_conversations').createIndex({ userId: 1, updatedAt: -1 });

  const email = env.ADMIN_EMAIL.toLowerCase();
  const existing = await users.findOne({ email });
  if (!existing) {
    await users.insertOne({
      email,
      name: 'Administrator',
      role: 'admin',
      passwordHash: await hashPassword(env.ADMIN_PASSWORD),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  global.__paklean_bootstrap_done = true;
}
