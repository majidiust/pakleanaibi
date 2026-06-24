// Structural diff utilities for aggregation pipelines. Used by:
//   1. The Partial-Modification guard in /api/reports/agentic to detect when
//      the LLM regenerated a pipeline that the user asked to merely refine.
//   2. The version-diff endpoint in /api/agentic/conversations/[id]/versions
//      so analysts can compare two snapshots side-by-side.
//
// The diff is COARSE on purpose: we count add / remove / modify per stage
// position and surface the operator types that changed. Sub-document deltas
// (e.g. "you renamed one key inside $project") are not attempted — they're
// the LLM's job to summarise in its "explanation" message.

type Stage = Record<string, unknown>;

// Canonical JSON: stable key order so two structurally identical stages
// always hash to the same string regardless of how the LLM serialised them.
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function stageOp(s: Stage): string {
  const k = Object.keys(s)[0];
  return k ?? '<empty>';
}

export interface PipelineDiff {
  prevLen: number;
  nextLen: number;
  // Position-aware counts.
  unchanged: number;
  added: number;
  removed: number;
  modified: number;
  // Per-stage outcome at each position of the longer pipeline.
  perStage: Array<{
    index: number;
    op: string;
    status: 'same' | 'modified' | 'added' | 'removed';
  }>;
  // Coarse architectural flags that almost always indicate a structural
  // (not local) edit. Used by the Partial-Modification guard.
  collectionChanged: boolean;
  lookupSetChanged: boolean;
  groupKeysChanged: boolean;
  finalProjectColumnsChanged: boolean;
}

function lookupTargets(p: Stage[]): string[] {
  const xs: string[] = [];
  for (const s of p) {
    if (typeof s.$lookup === 'object' && s.$lookup) {
      const from = (s.$lookup as Record<string, unknown>).from;
      if (typeof from === 'string') xs.push(from);
    }
  }
  return xs.sort();
}

function groupIdKeys(p: Stage[]): string[] {
  const xs: string[] = [];
  for (const s of p) {
    if (typeof s.$group === 'object' && s.$group) {
      const id = (s.$group as Record<string, unknown>)._id;
      xs.push(canonical(id));
    }
  }
  return xs.sort();
}

function finalProjectColumns(p: Stage[]): string[] {
  // Walk backwards: the last $project / $addFields / $set / $group describes
  // the user-visible output. Return its key set sorted.
  for (let i = p.length - 1; i >= 0; i -= 1) {
    const s = p[i];
    const op = stageOp(s);
    if (op === '$project' || op === '$addFields' || op === '$set') {
      return Object.keys(s[op] as Record<string, unknown>).sort();
    }
    if (op === '$group') {
      return Object.keys(s.$group as Record<string, unknown>).sort();
    }
  }
  return [];
}

export function diffPipelines(
  prevColl: string, prevPipeline: Stage[],
  nextColl: string, nextPipeline: Stage[],
): PipelineDiff {
  const prevSigs = prevPipeline.map(s => ({ op: stageOp(s), sig: canonical(s) }));
  const nextSigs = nextPipeline.map(s => ({ op: stageOp(s), sig: canonical(s) }));
  const n = Math.max(prevSigs.length, nextSigs.length);
  let unchanged = 0, added = 0, removed = 0, modified = 0;
  const perStage: PipelineDiff['perStage'] = [];
  for (let i = 0; i < n; i += 1) {
    const a = prevSigs[i];
    const b = nextSigs[i];
    if (a && b) {
      if (a.sig === b.sig) { unchanged += 1; perStage.push({ index: i, op: b.op, status: 'same' }); }
      else { modified += 1; perStage.push({ index: i, op: b.op, status: 'modified' }); }
    } else if (b) {
      added += 1; perStage.push({ index: i, op: b.op, status: 'added' });
    } else if (a) {
      removed += 1; perStage.push({ index: i, op: a.op, status: 'removed' });
    }
  }
  return {
    prevLen: prevPipeline.length,
    nextLen: nextPipeline.length,
    unchanged, added, removed, modified,
    perStage,
    collectionChanged: prevColl !== nextColl,
    lookupSetChanged: canonical(lookupTargets(prevPipeline)) !== canonical(lookupTargets(nextPipeline)),
    groupKeysChanged: canonical(groupIdKeys(prevPipeline)) !== canonical(groupIdKeys(nextPipeline)),
    finalProjectColumnsChanged:
      canonical(finalProjectColumns(prevPipeline)) !== canonical(finalProjectColumns(nextPipeline)),
  };
}

// Intent classification for the user's latest message. Drives the
// Partial-Modification guard: a "local" instruction paired with a wide
// structural diff is the signal that the LLM ignored the preservation
// contract and silently rewrote the pipeline.
export type RefinementIntent = 'local' | 'structural' | 'ambiguous';

// Keyword sets are intentionally redundant (English + Persian) and matched
// case-insensitively. Order matters: structural cues win when both are
// present so "rewrite this and rename the column" is treated as structural.
const STRUCTURAL_CUES = [
  'rewrite', 'redo', 'start over', 'completely', 'different approach',
  'new query', 'scrap', 'from scratch', 'overhaul', 'restructure',
  'بازنویسی', 'از نو', 'کاملاً', 'رویکرد جدید', 'دوباره طراحی',
];
const LOCAL_CUES = [
  'rename', 'instead of', 'change to', 'switch to', 'replace ', 'use ',
  'add filter', 'add a filter', 'remove filter', 'drop filter', 'only show',
  'show only', 'limit to', 'top ', 'last ', 'first ', 'sort by', 'order by',
  'group by', 'hide ', 'exclude ', 'include ', 'descending', 'ascending',
  'chart', 'bar chart', 'line chart', 'pie chart', 'table', 'graph',
  'تغییر نام', 'به جای', 'فقط', 'فیلتر اضافه', 'فیلتر بردار', 'حذف فیلتر',
  'مرتب', 'صعودی', 'نزولی', 'نمودار', 'ستونی', 'خطی', 'دایره‌ای', 'محدود',
];

export function classifyRefinementIntent(message: string): RefinementIntent {
  const m = ' ' + message.toLowerCase() + ' ';
  const isStructural = STRUCTURAL_CUES.some(k => m.includes(k.toLowerCase()));
  if (isStructural) return 'structural';
  const isLocal = LOCAL_CUES.some(k => m.includes(k.toLowerCase()));
  if (isLocal) return 'local';
  return 'ambiguous';
}

// Returns true when the new pipeline looks like a regenerate-from-scratch
// for an instruction the user phrased as a localised refinement. Reserved
// for instructions classified as 'local' — 'ambiguous' refinements are
// allowed wider edits because the user did not commit to a small scope.
export function isOverbroadEdit(intent: RefinementIntent, d: PipelineDiff): boolean {
  if (intent !== 'local') return false;
  // Hard signals: anything that changes the anchor / join graph / grouping
  // when the user asked for a local edit is overbroad.
  if (d.collectionChanged || d.lookupSetChanged || d.groupKeysChanged) return true;
  // Soft signal: more than half the stages were rewritten or shuffled.
  const churn = d.modified + d.added + d.removed;
  const baseline = Math.max(1, d.prevLen);
  return churn / baseline > 0.5;
}

// Short human-readable summary used in version cards and in the
// preservation-contract clarification message.
export function summariseDiff(d: PipelineDiff): string {
  const parts: string[] = [];
  if (d.collectionChanged) parts.push('anchor collection');
  if (d.lookupSetChanged) parts.push('join targets');
  if (d.groupKeysChanged) parts.push('grouping keys');
  if (d.finalProjectColumnsChanged) parts.push('output columns');
  if (d.added) parts.push(`${d.added} new stage${d.added === 1 ? '' : 's'}`);
  if (d.removed) parts.push(`${d.removed} removed stage${d.removed === 1 ? '' : 's'}`);
  if (d.modified) parts.push(`${d.modified} modified stage${d.modified === 1 ? '' : 's'}`);
  if (parts.length === 0) return 'no structural changes';
  return parts.join(', ');
}
