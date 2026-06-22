// Orchestrator. runAnalysis() walks the data DB, runs discovery + relationship
// detection + LLM descriptions, then writes results into the BI metadata DB
// while preserving manual / approved / rejected relationship state.
import { ObjectId } from 'mongodb';
import { dataDb } from '../mongo';
import { sampleCollection, inferTags } from './discover';
import { discoverRelationships, relFingerprint } from './relationships';
import { describeCollections } from './describe';
import { snapshot } from './versioning';
import { audit, intelColl, intelJobs, intelRels } from './storage';
import type { IntelCollection, IntelJob, IntelRelationship } from './types';

declare global {
  // eslint-disable-next-line no-var
  var __paklean_intel_running: boolean | undefined;
}

async function listUserCollections(): Promise<string[]> {
  const db = await dataDb();
  const all = await db.listCollections({}, { nameOnly: true }).toArray();
  return all.map(c => c.name).filter(n => !n.startsWith('system.') && !n.startsWith('_sync_state'));
}

export async function startJob(actor: string): Promise<IntelJob> {
  const jobs = await intelJobs();
  const names = await listUserCollections();
  const job: IntelJob = {
    kind: 'analyze', status: 'pending',
    startedAt: new Date(), startedBy: actor,
    progress: 0, step: 'queued',
    perCollection: names.map(n => ({ name: n, state: 'pending' })),
  };
  const r = await jobs.insertOne(job);
  job._id = r.insertedId;
  // Fire-and-forget; the job updates its own row.
  void runAnalysis(r.insertedId, actor).catch(async (e: unknown) => {
    await jobs.updateOne({ _id: r.insertedId }, {
      $set: { status: 'error', error: String(e), finishedAt: new Date() },
    });
  });
  return job;
}

async function updateJob(id: ObjectId, patch: Partial<IntelJob>) {
  const jobs = await intelJobs();
  await jobs.updateOne({ _id: id }, { $set: patch });
}

async function setCollState(id: ObjectId, name: string, state: 'sampling' | 'done' | 'error', error?: string) {
  const jobs = await intelJobs();
  await jobs.updateOne(
    { _id: id, 'perCollection.name': name },
    { $set: { 'perCollection.$.state': state, ...(error ? { 'perCollection.$.error': error } : {}) } },
  );
}

export async function runAnalysis(jobId: ObjectId, actor: string): Promise<void> {
  if (global.__paklean_intel_running) {
    await updateJob(jobId, { status: 'error', error: 'another analysis is in progress', finishedAt: new Date() });
    return;
  }
  global.__paklean_intel_running = true;
  try {
    await audit(actor, 'analyze.start');
    await updateJob(jobId, { status: 'running', step: 'sampling collections' });
    const names = await listUserCollections();
    const colls = await intelColl();

    const fresh: IntelCollection[] = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      await setCollState(jobId, name, 'sampling');
      try {
        const s = await sampleCollection(name);
        const existing = await colls.findOne({ name });
        const tags = inferTags(name, s.fields);
        const doc: IntelCollection = {
          name,
          label: existing?.label,
          description: existing?.descriptionLocked ? existing?.description : existing?.description,
          descriptionLocked: existing?.descriptionLocked,
          entity: existing?.entity,
          tags,
          docCount: s.docCount,
          fields: s.fields,
          indexes: s.indexes,
          samples: s.samples,
          sampledAt: new Date(),
          sampledSize: s.fields.length ? Math.min(200, s.docCount) : 0,
          version: (existing?.version ?? 0) + 1,
          notes: existing?.notes,
          createdAt: existing?.createdAt ?? new Date(),
          updatedAt: new Date(),
        };
        fresh.push(doc);
        await setCollState(jobId, name, 'done');
      } catch (e) {
        await setCollState(jobId, name, 'error', String(e));
      }
      await updateJob(jobId, { progress: Math.round(((i + 1) / names.length) * 60) });
    }

    // ---- Descriptions ------------------------------------------------------
    await updateJob(jobId, { step: 'generating descriptions', progress: 65 });
    const descs = await describeCollections(fresh);
    for (const c of fresh) {
      const d = descs.get(c.name);
      if (d && !c.descriptionLocked) { c.description = d.description; c.entity = d.entity; }
    }

    // ---- Persist collections (upsert, never drop) --------------------------
    await updateJob(jobId, { step: 'persisting collections', progress: 70 });
    for (const c of fresh) {
      await colls.updateOne({ name: c.name }, { $set: c }, { upsert: true });
    }
    // Remove collections that no longer exist in the data DB.
    const alive = new Set(fresh.map(c => c.name));
    const stale = await colls.find({}).project<{ name: string }>({ name: 1 }).toArray();
    for (const { name } of stale) if (!alive.has(name)) await colls.deleteOne({ name });

    // ---- Relationships -----------------------------------------------------
    await updateJob(jobId, { step: 'discovering relationships', progress: 80 });
    const suggestions = await discoverRelationships(fresh);
    const rels = await intelRels();

    // Preserve manual / approved / rejected: only insert NEW suggestions, and
    // refresh signals/confidence on still-suggested ones.
    let added = 0, boosted = 0;
    for (const s of suggestions) {
      const existing = await rels.findOne({ fingerprint: s.fingerprint });
      if (!existing) {
        await rels.insertOne(s);
        added++;
      } else if (existing.status === 'suggested') {
        await rels.updateOne(
          { fingerprint: s.fingerprint },
          { $set: { confidence: s.confidence, signals: s.signals, reason: s.reason, updatedAt: new Date() } },
        );
        if (s.confidence > existing.confidence) boosted++;
      }
      // approved/rejected/manual rows are intentionally left untouched.
    }

    // ---- Versioning + finalise --------------------------------------------
    await updateJob(jobId, { step: 'snapshotting version', progress: 95 });
    await snapshot(actor);
    const stats = {
      collections: fresh.length,
      fields: fresh.reduce((a, c) => a + c.fields.length, 0),
      suggested: added,
      autoBoosted: boosted,
    };
    await updateJob(jobId, { status: 'done', step: 'done', progress: 100, finishedAt: new Date(), stats });
    await audit(actor, 'analyze.done', undefined, stats);
  } finally {
    global.__paklean_intel_running = false;
  }
}

export async function latestJob(): Promise<IntelJob | null> {
  const jobs = await intelJobs();
  return jobs.find({}).sort({ startedAt: -1 }).limit(1).next();
}

export async function getJob(id: string): Promise<IntelJob | null> {
  if (!ObjectId.isValid(id)) return null;
  const jobs = await intelJobs();
  return jobs.findOne({ _id: new ObjectId(id) });
}

// Manual fingerprint helper exposed to API layer.
export { relFingerprint };
