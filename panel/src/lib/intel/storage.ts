// Storage layer for intel_* collections. All metadata lives in the BI DB so
// rescans can't lose user-approved data and the data DB stays read-only.
import { ObjectId, type Collection } from 'mongodb';
import { biDb } from '../mongo';
import type {
  IntelCollection, IntelRelationship, IntelJob, IntelVersion,
  IntelLearning, IntelAudit, IntelEnumLabel,
  IntelReportTemplate, IntelReportTemplateVersion,
} from './types';

const C = {
  collections: 'intel_collections',
  relationships: 'intel_relationships',
  jobs: 'intel_jobs',
  versions: 'intel_versions',
  learning: 'intel_learning',
  audit: 'intel_audit',
  enumLabels: 'intel_enum_labels',
  templates: 'report_templates',
  templateVersions: 'report_template_versions',
} as const;

declare global {
  // eslint-disable-next-line no-var
  var __paklean_intel_indexes_done: boolean | undefined;
}

async function ensureIndexes() {
  if (global.__paklean_intel_indexes_done) return;
  const db = await biDb();
  await Promise.all([
    db.collection(C.collections).createIndex({ name: 1 }, { unique: true }),
    db.collection(C.collections).createIndex({ tags: 1 }),
    db.collection(C.relationships).createIndex({ fingerprint: 1 }, { unique: true }),
    db.collection(C.relationships).createIndex({ status: 1, confidence: -1 }),
    db.collection(C.relationships).createIndex({ 'source.collection': 1 }),
    db.collection(C.relationships).createIndex({ 'target.collection': 1 }),
    db.collection(C.jobs).createIndex({ startedAt: -1 }),
    db.collection(C.versions).createIndex({ version: -1 }),
    db.collection(C.learning).createIndex({ pattern: 1 }, { unique: true }),
    db.collection(C.audit).createIndex({ ts: -1 }),
    db.collection(C.enumLabels).createIndex({ collection: 1, path: 1 }, { unique: true }),
    db.collection(C.templates).createIndex({ createdBy: 1, updatedAt: -1 }),
    db.collection(C.templates).createIndex({ visibility: 1, updatedAt: -1 }),
    db.collection(C.templates).createIndex({ category: 1 }),
    db.collection(C.templates).createIndex({ tags: 1 }),
    db.collection(C.templates).createIndex({ title: 1 }),
    db.collection(C.templateVersions).createIndex({ templateId: 1, version: -1 }),
  ]);
  global.__paklean_intel_indexes_done = true;
}

export async function intelColl(): Promise<Collection<IntelCollection>> {
  await ensureIndexes(); return (await biDb()).collection<IntelCollection>(C.collections);
}
export async function intelRels(): Promise<Collection<IntelRelationship>> {
  await ensureIndexes(); return (await biDb()).collection<IntelRelationship>(C.relationships);
}
export async function intelJobs(): Promise<Collection<IntelJob>> {
  await ensureIndexes(); return (await biDb()).collection<IntelJob>(C.jobs);
}
export async function intelVersions(): Promise<Collection<IntelVersion>> {
  await ensureIndexes(); return (await biDb()).collection<IntelVersion>(C.versions);
}
export async function intelLearning(): Promise<Collection<IntelLearning>> {
  await ensureIndexes(); return (await biDb()).collection<IntelLearning>(C.learning);
}
export async function intelAudit(): Promise<Collection<IntelAudit>> {
  await ensureIndexes(); return (await biDb()).collection<IntelAudit>(C.audit);
}
export async function intelEnumLabels(): Promise<Collection<IntelEnumLabel>> {
  await ensureIndexes(); return (await biDb()).collection<IntelEnumLabel>(C.enumLabels);
}
export async function reportTemplates(): Promise<Collection<IntelReportTemplate>> {
  await ensureIndexes(); return (await biDb()).collection<IntelReportTemplate>(C.templates);
}
export async function reportTemplateVersions(): Promise<Collection<IntelReportTemplateVersion>> {
  await ensureIndexes(); return (await biDb()).collection<IntelReportTemplateVersion>(C.templateVersions);
}

export async function audit(actor: string, action: string, target?: string, details?: Record<string, unknown>) {
  const a = await intelAudit();
  await a.insertOne({ ts: new Date(), actor, action, target, details });
}

export function oid(id: string): ObjectId | null {
  return ObjectId.isValid(id) ? new ObjectId(id) : null;
}
