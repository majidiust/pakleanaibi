import { MongoClient, type Db } from 'mongodb';
import { env } from './env';

// We use a single MongoClient (driver maintains an internal connection pool)
// and expose two named Db handles: the BI metadata DB (writable) and the data
// DB (read-only by convention -- enforced by code in pipeline-guard.ts).
declare global {
  // eslint-disable-next-line no-var
  var __paklean_mongo: { client: MongoClient; promise: Promise<MongoClient> } | undefined;
  // eslint-disable-next-line no-var
  var __paklean_mongo_version: { major: number; minor: number; patch: number; raw: string } | undefined;
}

function getClient(): Promise<MongoClient> {
  if (!global.__paklean_mongo) {
    const client = new MongoClient(env.MONGO_URI, {
      maxPoolSize: 20,
      serverSelectionTimeoutMS: 8000,
    });
    global.__paklean_mongo = { client, promise: client.connect() };
  }
  return global.__paklean_mongo.promise;
}

export async function biDb(): Promise<Db> {
  const c = await getClient();
  return c.db(env.BI_DB);
}

export async function dataDb(): Promise<Db> {
  const c = await getClient();
  return c.db(env.DATA_DB);
}

// Read the data-DB server version once and cache it. Used by the LLM prompt
// to constrain the aggregation operators it picks (e.g. $dateSubtract / $$NOW
// only exist on 5.0+ / 4.2+), and by pipeline lowering to rewrite modern
// expressions into literals the server can evaluate.
export interface MongoServerInfo {
  major: number; minor: number; patch: number; raw: string;
}
export async function getServerInfo(): Promise<MongoServerInfo> {
  if (global.__paklean_mongo_version) return global.__paklean_mongo_version;
  const c = await getClient();
  let raw = '0.0.0';
  try {
    const info = await c.db('admin').command({ buildInfo: 1 });
    if (typeof info.version === 'string') raw = info.version;
  } catch { /* leave as 0.0.0 */ }
  const m = raw.match(/^(\d+)\.(\d+)\.(\d+)/);
  const major = m ? Number(m[1]) : 0;
  const minor = m ? Number(m[2]) : 0;
  const patch = m ? Number(m[3]) : 0;
  global.__paklean_mongo_version = { major, minor, patch, raw };
  return global.__paklean_mongo_version;
}
