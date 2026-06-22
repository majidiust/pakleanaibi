// Types for the Database Intelligence module. All metadata lives in the BI
// database (writable); the data database is only ever read.
import type { ObjectId } from 'mongodb';

export type FieldType =
  | 'string' | 'number' | 'integer' | 'double' | 'long' | 'decimal'
  | 'boolean' | 'date' | 'objectId' | 'array' | 'object'
  | 'null' | 'binary' | 'regex' | 'mixed';

export type RelationshipType =
  | 'one-to-one'
  | 'one-to-many'
  | 'many-to-one'
  | 'many-to-many'
  | 'embedded'
  | 'soft'
  | 'derived'
  | 'chain';

export type RelationshipStatus =
  | 'suggested'   // auto-discovered, awaiting review
  | 'approved'    // accepted by a human
  | 'rejected'    // explicitly rejected; remembered to avoid re-suggestion
  | 'manual'      // created by hand; highest priority, never overwritten
  | 'archived';   // superseded but kept for history

export type DetectionMethod =
  | 'objectId-naming'
  | 'objectId-value'
  | 'dbref'
  | 'embedded'
  | 'soft-name'
  | 'soft-value'
  | 'similar-field'
  | 'derived'
  | 'manual'
  | 'learned';

export interface FieldSample {
  /** Dot-path; nested fields use a.b.c notation. */
  path: string;
  /** All observed BSON types (sorted, unique). */
  types: FieldType[];
  /** Element types if any observed value is an array. */
  arrayOf?: FieldType[];
  /** % of sampled documents that contain this field. */
  presence: number;
  /** % of present values that are null. */
  nullRate: number;
  /** Distinct values observed (capped). */
  distinctCount: number;
  /** Approximate uniqueness ratio across sample: distinct / nonNull. */
  uniqueness: number;
  /** Inferred enum values when distinctCount is small and stable. */
  enumValues?: (string | number | boolean)[];
  /** True when the value pattern resembles a 24-char hex ObjectId hex string. */
  looksLikeObjectIdString?: boolean;
  /** True when the field is a known timestamp (createdAt, updatedAt, ts, ...). */
  isTimestamp?: boolean;
  /** First few non-null sample values, redacted of obvious secrets. */
  examples: unknown[];
}

export interface IntelCollection {
  _id?: ObjectId;
  /** Collection name as it appears in the data DB. */
  name: string;
  /** Display label (defaults to name). */
  label?: string;
  /** Short AI/heuristic-generated description. Manually editable. */
  description?: string;
  /** Whether the description was set by a human (locks it from rescans). */
  descriptionLocked?: boolean;
  /** Best-guess business entity (User, Order, Transaction, Wallet, ...). */
  entity?: string;
  /** Domain tags inferred from fields and naming. */
  tags: string[];
  /** Document count at last analysis. */
  docCount: number;
  /** Field-level sampling result. */
  fields: FieldSample[];
  /** Index definitions read from the data DB. */
  indexes: { name: string; keys: Record<string, 1 | -1 | 'text'>; unique: boolean }[];
  /** Sample documents (small, capped) for the detail page. */
  samples: unknown[];
  /** Sampling parameters used. */
  sampledAt: Date;
  sampledSize: number;
  /** Bumped each time the collection is re-analysed. */
  version: number;
  /** Free-form user notes. */
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface RelationshipEndpoint {
  collection: string;
  field: string;            // dot path
  /** "_id" / "email" / ... what is matched on the target side. */
  matchOn?: string;
}

export interface IntelRelationship {
  _id?: ObjectId;
  /** Stable hash of (source, sourceField, target, targetField, type). */
  fingerprint: string;
  source: RelationshipEndpoint;
  target: RelationshipEndpoint;
  type: RelationshipType;
  cardinality?: '1:1' | '1:N' | 'N:1' | 'N:N';
  status: RelationshipStatus;
  /** 0-100; -1 for manual relationships (always-on). */
  confidence: number;
  detection: DetectionMethod;
  /** Human-readable reason for the suggestion. */
  reason: string;
  /** Signals that fed into the confidence calculation. */
  signals: { label: string; weight: number; note?: string }[];
  /** Optional visual styling for the graph. */
  color?: string;
  tags: string[];
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: string;       // user sub
  approvedBy?: string;
  approvedAt?: Date;
  rejectedBy?: string;
  rejectedAt?: Date;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface IntelJob {
  _id?: ObjectId;
  kind: 'analyze';
  status: JobStatus;
  startedAt: Date;
  finishedAt?: Date;
  startedBy: string;
  progress: number;          // 0-100
  step: string;              // current step label
  /** Per-collection progress for the UI. */
  perCollection: { name: string; state: 'pending' | 'sampling' | 'done' | 'error'; error?: string }[];
  stats?: {
    collections: number;
    fields: number;
    suggested: number;
    autoBoosted: number;
  };
  error?: string;
}

export interface IntelVersion {
  _id?: ObjectId;
  version: number;
  takenAt: Date;
  takenBy: string;
  collections: number;
  relationships: number;
  /** Compact snapshot. Full snapshot stored as a sub-document. */
  snapshot: {
    collections: Pick<IntelCollection, 'name' | 'description' | 'docCount' | 'fields' | 'indexes' | 'entity' | 'tags'>[];
    relationships: Pick<IntelRelationship, 'fingerprint' | 'source' | 'target' | 'type' | 'status' | 'confidence'>[];
  };
}

export interface IntelLearning {
  _id?: ObjectId;
  /** Generalized pattern signature used to look up future suggestions. */
  pattern: string;
  /** +1 boost or -1 penalty applied to confidence of matching suggestions. */
  delta: number;
  /** Number of times this pattern has been confirmed. */
  count: number;
  /** Human-readable description. */
  hint: string;
  updatedAt: Date;
}

export interface IntelAudit {
  _id?: ObjectId;
  ts: Date;
  actor: string;            // user sub
  action: string;           // 'analyze.start' / 'rel.approve' / ...
  target?: string;
  details?: Record<string, unknown>;
}
