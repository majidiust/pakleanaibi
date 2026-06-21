// Read-only incremental sync: primary (MongoDB 3.4) -> secondary (MongoDB 8.x).
// IMPORTANT: this process MUST NEVER write to the primary. Only `find()` on primary.
//
// Strategy: per collection, track the highest `_id` already copied in
// secondary db._sync_state. Next run: copy docs with _id > watermark.
// Limitations: catches inserts only (not in-place updates or deletes).

const { MongoClient: NewClient } = require("mongodb");
const LegacyMongo = require("mongodb-legacy-driver");

const env = process.env;
const SYNC_INTERVAL_MS = Math.max(1, parseInt(env.SYNC_INTERVAL_SECONDS || "60", 10)) * 1000;
const BATCH_SIZE = Math.max(1, parseInt(env.SYNC_BATCH_SIZE || "500", 10));
const STATE_COLL = "_sync_state";
const SKIP_PREFIXES = ["system.", "_sync_", "objectlabs-system"];

function primaryUri() {
  const u = encodeURIComponent(env.PRIMARY_USERNAME);
  const p = encodeURIComponent(env.PRIMARY_PASSWORD);
  return `mongodb://${u}:${p}@${env.PRIMARY_HOST}:${env.PRIMARY_PORT}/${env.PRIMARY_DB}` +
    `?authSource=${env.PRIMARY_AUTH_SOURCE}&directConnection=true&serverSelectionTimeoutMS=15000`;
}
function secondaryUri() {
  const u = encodeURIComponent(env.SECONDARY_USERNAME);
  const p = encodeURIComponent(env.SECONDARY_PASSWORD);
  return `mongodb://${u}:${p}@${env.SECONDARY_HOST}:${env.SECONDARY_PORT}/${env.SECONDARY_DB}` +
    `?authSource=${env.SECONDARY_AUTH_SOURCE}&directConnection=true&serverSelectionTimeoutMS=15000`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);
const err = (...a) => console.error(new Date().toISOString(), ...a);

async function getWatermark(secDb, coll) {
  const doc = await secDb.collection(STATE_COLL).findOne({ _id: coll });
  return doc ? doc.lastId : null;
}
async function setWatermark(secDb, coll, lastId) {
  await secDb.collection(STATE_COLL).updateOne(
    { _id: coll },
    { $set: { lastId, updatedAt: new Date() } },
    { upsert: true }
  );
}

// Returns the starting `_id` for incremental sync. Order of precedence:
//   1. stored watermark from previous run
//   2. max `_id` already present in the secondary (i.e. left by bootstrap)
//   3. null (fresh collection, copy everything)
async function resolveStartId(secDb, coll) {
  const wm = await getWatermark(secDb, coll);
  if (wm) return wm;
  const top = await secDb
    .collection(coll)
    .find({}, { projection: { _id: 1 }, sort: { _id: -1 }, limit: 1 })
    .next();
  if (top) {
    await setWatermark(secDb, coll, top._id);
    log(`  ~ ${coll}: watermark seeded from bootstrap max _id`);
    return top._id;
  }
  return null;
}

async function syncCollection(priDb, secDb, name) {
  let lastId = await resolveStartId(secDb, name);
  const filter = lastId ? { _id: { $gt: lastId } } : {};
  const cursor = priDb.collection(name).find(filter, { sort: { _id: 1 }, batchSize: BATCH_SIZE });

  let batch = [];
  let copied = 0;
  let newest = lastId;
  const t0 = Date.now();

  const flush = async () => {
    if (!batch.length) return;
    const ops = batch.map((d) => ({
      replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true },
    }));
    await secDb.collection(name).bulkWrite(ops, { ordered: false });
    copied += batch.length;
    newest = batch[batch.length - 1]._id;
    await setWatermark(secDb, name, newest);
    batch = [];
  };

  while (await cursor.hasNext()) {
    batch.push(await cursor.next());
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  if (copied > 0) {
    log(`  + ${name}: copied ${copied} doc(s) in ${Date.now() - t0}ms`);
  }
  return copied;
}

async function syncOnce(priDb, secDb) {
  const cols = await priDb.listCollections({}, { nameOnly: true }).toArray();
  const names = cols
    .map((c) => c.name)
    .filter((n) => !SKIP_PREFIXES.some((p) => n.startsWith(p)))
    .sort();

  log(`sync pass: ${names.length} collection(s)`);
  let total = 0;
  for (const n of names) {
    try {
      total += await syncCollection(priDb, secDb, n);
    } catch (e) {
      err(`  ! ${n}: ${e.message}`);
    }
  }
  log(`sync pass done: ${total} new doc(s)`);
}

async function withRetries(label, fn) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      err(`${label} attempt ${i} failed: ${e.message}`);
      if (i >= 5) throw e;
      await sleep(Math.min(30000, 2000 * i));
    }
  }
}

async function main() {
  log("starting sync service");
  log(`primary: ${env.PRIMARY_HOST}:${env.PRIMARY_PORT}/${env.PRIMARY_DB} (authSource=${env.PRIMARY_AUTH_SOURCE})`);
  log(`secondary: ${env.SECONDARY_HOST}:${env.SECONDARY_PORT}/${env.SECONDARY_DB}`);
  log(`interval=${SYNC_INTERVAL_MS / 1000}s batch=${BATCH_SIZE}`);

  const primary = await withRetries("primary connect", async () => {
    const c = new LegacyMongo.MongoClient(primaryUri(), { useUnifiedTopology: true });
    await c.connect();
    return c;
  });
  const secondary = await withRetries("secondary connect", async () => {
    const c = new NewClient(secondaryUri());
    await c.connect();
    return c;
  });

  const priDb = primary.db(env.PRIMARY_DB);
  const secDb = secondary.db(env.SECONDARY_DB);

  const shutdown = async (sig) => {
    log(`received ${sig}, closing`);
    await primary.close().catch(() => {});
    await secondary.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  while (true) {
    try { await syncOnce(priDb, secDb); }
    catch (e) { err("sync pass error:", e.message); }
    await sleep(SYNC_INTERVAL_MS);
  }
}

main().catch((e) => { err("fatal:", e); process.exit(1); });
