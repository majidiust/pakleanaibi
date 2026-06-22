// Schema versioning. Every successful analysis snapshots the current state
// and writes it to intel_versions; the diff helper compares two versions for
// the UI history page.
import { intelColl, intelRels, intelVersions } from './storage';
import type { IntelVersion } from './types';

export async function snapshot(takenBy: string): Promise<IntelVersion> {
  const [colls, rels, versions] = await Promise.all([intelColl(), intelRels(), intelVersions()]);
  const [cDocs, rDocs, last] = await Promise.all([
    colls.find({}).toArray(),
    rels.find({}).toArray(),
    versions.find({}).sort({ version: -1 }).limit(1).next(),
  ]);
  const version = (last?.version ?? 0) + 1;
  const snap: IntelVersion = {
    version, takenAt: new Date(), takenBy,
    collections: cDocs.length, relationships: rDocs.length,
    snapshot: {
      collections: cDocs.map(c => ({
        name: c.name, description: c.description, docCount: c.docCount,
        fields: c.fields, indexes: c.indexes, entity: c.entity, tags: c.tags,
      })),
      relationships: rDocs.map(r => ({
        fingerprint: r.fingerprint, source: r.source, target: r.target,
        type: r.type, status: r.status, confidence: r.confidence,
      })),
    },
  };
  await versions.insertOne(snap);
  return snap;
}

export interface VersionDiff {
  collections: {
    added: string[];
    removed: string[];
    fieldChanges: { name: string; addedFields: string[]; removedFields: string[] }[];
  };
  relationships: {
    added: string[];
    removed: string[];
    statusChanges: { fingerprint: string; from: string; to: string }[];
  };
}

export async function diffVersions(a: number, b: number): Promise<VersionDiff> {
  const versions = await intelVersions();
  const [va, vb] = await Promise.all([
    versions.findOne({ version: a }),
    versions.findOne({ version: b }),
  ]);
  if (!va || !vb) throw new Error('version not found');
  const namesA = new Set(va.snapshot.collections.map(c => c.name));
  const namesB = new Set(vb.snapshot.collections.map(c => c.name));
  const added = [...namesB].filter(n => !namesA.has(n));
  const removed = [...namesA].filter(n => !namesB.has(n));
  const both = [...namesA].filter(n => namesB.has(n));
  const fieldChanges = both.map(n => {
    const ca = va.snapshot.collections.find(c => c.name === n)!;
    const cb = vb.snapshot.collections.find(c => c.name === n)!;
    const fa = new Set(ca.fields.map(f => f.path));
    const fb = new Set(cb.fields.map(f => f.path));
    return {
      name: n,
      addedFields: [...fb].filter(p => !fa.has(p)),
      removedFields: [...fa].filter(p => !fb.has(p)),
    };
  }).filter(x => x.addedFields.length || x.removedFields.length);

  const ra = new Map(va.snapshot.relationships.map(r => [r.fingerprint, r] as const));
  const rb = new Map(vb.snapshot.relationships.map(r => [r.fingerprint, r] as const));
  const relAdded = [...rb.keys()].filter(k => !ra.has(k));
  const relRemoved = [...ra.keys()].filter(k => !rb.has(k));
  const statusChanges: { fingerprint: string; from: string; to: string }[] = [];
  for (const [fp, r] of rb.entries()) {
    const prev = ra.get(fp);
    if (prev && prev.status !== r.status) statusChanges.push({ fingerprint: fp, from: prev.status, to: r.status });
  }
  return {
    collections: { added, removed, fieldChanges },
    relationships: { added: relAdded, removed: relRemoved, statusChanges },
  };
}
