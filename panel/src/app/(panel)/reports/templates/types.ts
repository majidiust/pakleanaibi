// Shared client-side shape for the Saved Reports module. Mirrors the BSON
// `IntelReportTemplate` from src/lib/intel/types.ts but with `id` (string)
// instead of `_id` (ObjectId) so it travels cleanly over JSON.
import type {
  TemplateParameter, TemplateDisplay, TemplateVisibility, TemplateRelationshipRef,
} from '@/lib/intel/types';

export type { TemplateParameter, TemplateDisplay, TemplateVisibility, TemplateRelationshipRef };

export interface TemplateSummary {
  id: string;
  title: string;
  description?: string;
  category?: string;
  tags: string[];
  visibility: TemplateVisibility;
  collection: string;
  usedCollections: string[];
  parameters: TemplateParameter[];
  display: TemplateDisplay;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy?: string;
  lastRunAt?: string;
  lastRunStatus?: 'ok' | 'failed';
  lastRunError?: string;
  lastRunTookMs?: number;
  lastRunRowCount?: number;
  runCount: number;
}

export interface TemplateFull extends TemplateSummary {
  pipeline: Record<string, unknown>[];
  usedRelationships: TemplateRelationshipRef[];
  outputFields?: string[];
  defaultSort?: { field: string; direction: 1 | -1 };
  sourcePrompt?: string;
}

export interface TemplateDetail {
  template: TemplateFull;
  drift: { missing: TemplateRelationshipRef[] };
}

export interface TemplateVersionEntry {
  id: string;
  version: number;
  takenAt: string;
  takenBy: string;
  note?: string;
}
