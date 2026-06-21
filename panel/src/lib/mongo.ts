import { MongoClient, type Db } from 'mongodb';
import { env } from './env';

// We use a single MongoClient (driver maintains an internal connection pool)
// and expose two named Db handles: the BI metadata DB (writable) and the data
// DB (read-only by convention -- enforced by code in pipeline-guard.ts).
declare global {
  // eslint-disable-next-line no-var
  var __paklean_mongo: { client: MongoClient; promise: Promise<MongoClient> } | undefined;
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
