// Pre-execution logical consistency checks for aggregation pipelines.
//
// This layer sits BEFORE Mongo execution and catches condition-level bugs
// the syntax allowlist in pipeline-guard.ts cannot see: conflicting filters,
// $limit-before-$sort, $match on a field that was projected away, $sort
// followed by a non-preserving $group, and so on.
//
// For each issue the check returns either:
//   - autofix:  a structurally identical pipeline with the bug corrected
//               (e.g. $sort and $limit swapped), plus a short warning that
//               surfaces in the report.
//   - clarify:  no safe rewrite is possible; the route should escalate to a
//               friendly clarifying question (logged in detail, sanitised on
//               the wire) instead of executing a likely-wrong pipeline.

type Stage = Record<string, unknown>;
export type LogicVerdict =
  | { ok: true }
  | { ok: false; mode: 'autofix'; pipeline: Stage[]; warning: string; rule: string }
  | { ok: false; mode: 'clarify'; issue: string; question: string; rule: string };

function stageOp(s: Stage): string {
  const k = Object.keys(s)[0];
  return k ?? '<empty>';
}

// Walk an expression tree and collect every "$<fieldPath>" reference so we
// can answer "does this stage reference field X?" without re-implementing
// the Mongo expression grammar.
function collectFieldRefs(node: unknown, out: Set<string>): void {
  if (node === null || typeof node !== 'object') {
    if (typeof node === 'string' && node.startsWith('$') && !node.startsWith('$$')) {
      out.add(node.slice(1).split('.')[0]);
    }
    return;
  }
  if (Array.isArray(node)) { for (const v of node) collectFieldRefs(v, out); return; }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    // Top-level field keys in $match / $project also count.
    if (!k.startsWith('$') && !k.startsWith('_')) out.add(k.split('.')[0]);
    collectFieldRefs(v, out);
  }
}

function matchFieldKeys(matchBody: unknown): string[] {
  if (!matchBody || typeof matchBody !== 'object') return [];
  const keys: string[] = [];
  for (const k of Object.keys(matchBody as Record<string, unknown>)) {
    if (k === '$and' || k === '$or' || k === '$nor') {
      const arr = (matchBody as Record<string, unknown>)[k];
      if (Array.isArray(arr)) for (const c of arr) keys.push(...matchFieldKeys(c));
    } else if (k === '$expr') {
      const refs = new Set<string>();
      collectFieldRefs((matchBody as Record<string, unknown>)[k], refs);
      keys.push(...refs);
    } else if (!k.startsWith('$')) {
      keys.push(k);
    }
  }
  return keys;
}

// Track the SET of fields that survive each stage. We start in an
// "unknown / permissive" mode (null) because the schema digest is not on
// the hot path here; we only switch to a concrete set after a strict
// $project / $group that we can read directly. This avoids false positives
// when the user genuinely passes everything through.
type FieldSet = { mode: 'unknown' } | { mode: 'known'; fields: Set<string> };

function applyStageToFieldSet(s: Stage, fs: FieldSet): FieldSet {
  const op = stageOp(s);
  if (op === '$project') {
    const body = s.$project as Record<string, unknown>;
    const incl = Object.entries(body).filter(([, v]) => v === 1 || v === true);
    const excl = Object.entries(body).filter(([, v]) => v === 0 || v === false);
    if (incl.length > 0 && excl.length === 0) {
      // Strict inclusion mode: only listed fields + computed fields survive.
      const fields = new Set<string>([...incl.map(([k]) => k.split('.')[0]),
        ...Object.entries(body).filter(([, v]) => v !== 0 && v !== false && v !== 1 && v !== true).map(([k]) => k.split('.')[0])]);
      fields.add('_id');
      return { mode: 'known', fields };
    }
    if (excl.length > 0 && incl.length === 0 && fs.mode === 'known') {
      const fields = new Set(fs.fields);
      for (const [k] of excl) fields.delete(k.split('.')[0]);
      return { mode: 'known', fields };
    }
    return fs;
  }
  if (op === '$unset') {
    const body = s.$unset as string | string[];
    if (fs.mode !== 'known') return fs;
    const fields = new Set(fs.fields);
    const drop = Array.isArray(body) ? body : [body];
    for (const k of drop) fields.delete(String(k).split('.')[0]);
    return { mode: 'known', fields };
  }
  if (op === '$group') {
    const body = s.$group as Record<string, unknown>;
    return { mode: 'known', fields: new Set(Object.keys(body)) };
  }
  if (op === '$addFields' || op === '$set') {
    if (fs.mode !== 'known') return fs;
    const body = s[op] as Record<string, unknown>;
    const fields = new Set(fs.fields);
    for (const k of Object.keys(body)) fields.add(k.split('.')[0]);
    return { mode: 'known', fields };
  }
  if (op === '$replaceRoot' || op === '$replaceWith') {
    return { mode: 'unknown' };
  }
  if (op === '$lookup') {
    const body = s.$lookup as Record<string, unknown>;
    const asName = typeof body.as === 'string' ? body.as : null;
    if (fs.mode !== 'known' || !asName) return fs;
    const fields = new Set(fs.fields);
    fields.add(asName);
    return { mode: 'known', fields };
  }
  if (op === '$unwind') {
    return fs;
  }
  return fs;
}

export interface LogicCheckOptions {
  // When true, $limit-before-$sort autofixes only when the $limit is the
  // very next stage after the $sort would be expected, to avoid reordering
  // pipelines the analyst intentionally limited (e.g. preview mode).
  conservativeSortLimit?: boolean;
}

// Compare two literal values: numbers/strings/booleans/dates/ObjectId
// shorthands. Returns -1/0/1 when comparable, null when not (mixed types,
// nested objects, etc).
function compareLit(a: unknown, b: unknown): number | null {
  if (typeof a !== typeof b) return null;
  if (a === b) return 0;
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : 1;
  return null;
}

// Pull simple {$op: literal} clauses for a given field from a $match body,
// recursing into $and. Skips $or/$nor (disjunctions, not safely flatten).
function extractScalarClauses(body: unknown, field: string, out: Array<{ op: string; val: unknown }>): void {
  if (!body || typeof body !== 'object') return;
  const obj = body as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (k === '$and' && Array.isArray(v)) { for (const c of v) extractScalarClauses(c, field, out); continue; }
    if (k === '$or' || k === '$nor' || k === '$expr') continue;
    if (k !== field) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [op, val] of Object.entries(v as Record<string, unknown>)) {
        if (op.startsWith('$')) out.push({ op, val });
      }
    } else {
      out.push({ op: '$eq', val: v });
    }
  }
}

// Detect contradictions between two scalar clauses on the same field:
// "$eq" + different "$eq", "$gt 10" + "$lt 5", etc. Returns a short reason
// when the pair cannot both be satisfied, null otherwise.
function clausesContradict(a: { op: string; val: unknown }, b: { op: string; val: unknown }): string | null {
  if (a.op === '$eq' && b.op === '$eq') {
    return a.val !== b.val ? `$eq=${JSON.stringify(a.val)} then $eq=${JSON.stringify(b.val)}` : null;
  }
  const cmp = compareLit(a.val, b.val);
  if (cmp === null) return null;
  const pair = `${a.op} ${JSON.stringify(a.val)} then ${b.op} ${JSON.stringify(b.val)}`;
  if (a.op === '$gt' && (b.op === '$lt' || b.op === '$lte') && cmp >= 0) return pair;
  if ((a.op === '$lt' || a.op === '$lte') && b.op === '$gt' && cmp <= 0) return pair;
  if (a.op === '$gte' && b.op === '$lt' && cmp >= 0) return pair;
  if (a.op === '$lt' && b.op === '$gte' && cmp <= 0) return pair;
  if (a.op === '$eq' && b.op === '$ne' && a.val === b.val) return pair;
  if (a.op === '$ne' && b.op === '$eq' && a.val === b.val) return pair;
  return null;
}

// Detect whether a $-prefixed expression path's leaf segment looks like an
// ObjectId-bearing field by Mongo convention. We accept _id exactly and the
// classic camelCase foreign-key form *Id (userId, laundryId, customerId).
// We deliberately do NOT match arbitrary "Id"-suffix words ("invalidId" off
// a unrelated entity etc.) so the coercion stays conservative.
function isObjectIdFieldPath(p: unknown): boolean {
  if (typeof p !== 'string' || !p.startsWith('$') || p.startsWith('$$')) return false;
  const segs = p.slice(1).split('.');
  const last = segs[segs.length - 1];
  return last === '_id' || /^[a-z][a-zA-Z0-9]*Id$/.test(last);
}

function isObjectIdHexLiteral(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{24}$/i.test(v);
}

// Coerce raw 24-hex string literals that compare against an ObjectId field
// path into the EJSON shorthand {"$oid":"..."}. The pipeline-guard decodes
// that shorthand into a real BSON ObjectId before execution, so this rewrite
// turns the always-false comparison ($eq[ObjectId, string]) into the
// intended type-matched equality. Walks nested expressions ($cond, $switch,
// $and, $or, ...) without changing structural shape.
function coerceObjectIdEqualities(pipeline: Stage[]): { pipeline: Stage[]; count: number } {
  let count = 0;
  const wrap = (hex: string): Record<string, string> => ({ $oid: hex.toLowerCase() });
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if ((k === '$eq' || k === '$ne') && Array.isArray(v) && v.length === 2) {
        const [a, b] = v;
        if (isObjectIdFieldPath(a) && isObjectIdHexLiteral(b)) {
          count += 1;
          out[k] = [a, wrap(b)];
          continue;
        }
        if (isObjectIdFieldPath(b) && isObjectIdHexLiteral(a)) {
          count += 1;
          out[k] = [wrap(a), b];
          continue;
        }
      }
      if ((k === '$in' || k === '$nin') && Array.isArray(v) && v.length === 2) {
        const [a, b] = v;
        if (isObjectIdFieldPath(a) && Array.isArray(b)) {
          let changed = false;
          const coerced = b.map(x => {
            if (isObjectIdHexLiteral(x)) { changed = true; count += 1; return wrap(x); }
            return walk(x);
          });
          if (changed) { out[k] = [a, coerced]; continue; }
        }
      }
      out[k] = walk(v);
    }
    return out;
  };
  return { pipeline: pipeline.map(s => walk(s) as Stage), count };
}

export function checkLogicalConsistency(pipeline: Stage[]): LogicVerdict {
  // 0) ObjectId-string equality coercion. The LLM repeatedly compares an
  // _id field (BSON ObjectId) against a raw 24-hex string literal, which
  // MongoDB evaluates as false for every row under type bracketing. We
  // rewrite the literal to {"$oid":"..."} so the pipeline-guard converts
  // it to a real ObjectId at lowering time. Runs FIRST so downstream rules
  // see the corrected pipeline; the resulting warning is preserved even
  // when a later autofix (e.g. $sort/$limit swap) fires on the same turn.
  const coerced = coerceObjectIdEqualities(pipeline);
  const work = coerced.count > 0 ? coerced.pipeline : pipeline;
  const oidWarning = coerced.count > 0
    ? `Coerced ${coerced.count} ObjectId comparison(s) from raw hex string to {"$oid": "..."} so the equality matches the BSON type.`
    : null;

  // 1) $limit before $sort -> autofix swap. Most common LLM bug: the model
  // wants "top 10 by date" but writes [$limit, $sort] which limits to a
  // random sample then sorts the sample. Swap if and only if the two
  // stages are adjacent so we never alter the analyst's intent for a paged
  // pipeline like [$sort, $limit 10, $skip 10, $limit 10].
  for (let i = 0; i < work.length - 1; i += 1) {
    if (stageOp(work[i]) === '$limit' && stageOp(work[i + 1]) === '$sort') {
      const fixed = work.slice();
      [fixed[i], fixed[i + 1]] = [fixed[i + 1], fixed[i]];
      return {
        ok: false, mode: 'autofix', pipeline: fixed,
        rule: 'limit_before_sort',
        warning: oidWarning
          ? `${oidWarning} Also reordered stages: $sort must run before $limit so the top-N comes from a sorted set rather than a random sample.`
          : 'Reordered stages: $sort must run before $limit so the top-N comes from a sorted set rather than a random sample.',
      };
    }
  }

  // 2) Same-field contradictions across multiple $match stages. Walk every
  // pair of $match clauses on the same scalar field and flag impossible
  // combinations ($eq=A then $eq=B; $gt=10 then $lt=5; etc.). These would
  // silently return zero rows.
  const matches: Array<{ idx: number; body: unknown }> = [];
  for (let i = 0; i < work.length; i += 1) {
    if (stageOp(work[i]) === '$match') matches.push({ idx: i, body: work[i].$match });
  }
  if (matches.length > 1) {
    const fields = new Set<string>();
    for (const m of matches) for (const f of matchFieldKeys(m.body)) fields.add(f);
    for (const field of fields) {
      const clauses: Array<{ idx: number; op: string; val: unknown }> = [];
      for (const m of matches) {
        const local: Array<{ op: string; val: unknown }> = [];
        extractScalarClauses(m.body, field, local);
        for (const c of local) clauses.push({ idx: m.idx, op: c.op, val: c.val });
      }
      for (let i = 0; i < clauses.length; i += 1) {
        for (let j = i + 1; j < clauses.length; j += 1) {
          const why = clausesContradict(clauses[i], clauses[j]);
          if (why) {
            return {
              ok: false, mode: 'clarify',
              rule: 'contradictory_match',
              issue: `Field ${field} has contradicting filters across $match stages: ${why}.`,
              question: `Two filters on \`${field}\` (${why}) can never both match. Which condition did you intend to keep?`,
            };
          }
        }
      }
    }
  }

  // 3) $match references a field that an earlier stage removed. Track the
  // field set through $project / $unset / $group and flag any $match key
  // (or $expr ref) not in the visible set. Skips when the set is unknown
  // (e.g. after $replaceRoot) so we never raise on legitimately permissive
  // pipelines.
  let fs: FieldSet = { mode: 'unknown' };
  for (let i = 0; i < work.length; i += 1) {
    const s = work[i];
    if (stageOp(s) === '$match' && fs.mode === 'known') {
      const known = fs.fields;
      const refs = matchFieldKeys(s.$match);
      const missing = refs.filter(r => r !== '_id' && !known.has(r));
      if (missing.length > 0) {
        return {
          ok: false, mode: 'clarify',
          rule: 'match_on_removed_field',
          issue: `Stage ${i} ($match) references field(s) ${missing.join(', ')} that earlier stages removed.`,
          question: `The filter on \`${missing[0]}\` references a column that an earlier step removed. Did you want to keep \`${missing[0]}\` in the output, or filter on a different column?`,
        };
      }
    }
    fs = applyStageToFieldSet(s, fs);
  }

  // 4) Redundant $sort immediately followed by $group that does not use
  // $first / $last (so the sort order is discarded). Drop the dead $sort.
  for (let i = 0; i < work.length - 1; i += 1) {
    if (stageOp(work[i]) !== '$sort' || stageOp(work[i + 1]) !== '$group') continue;
    const group = work[i + 1].$group as Record<string, unknown>;
    const usesOrdered = JSON.stringify(group).includes('"$first"') || JSON.stringify(group).includes('"$last"');
    if (usesOrdered) continue;
    const fixed = work.slice(0, i).concat(work.slice(i + 1));
    return {
      ok: false, mode: 'autofix', pipeline: fixed,
      rule: 'dead_sort_before_group',
      warning: oidWarning
        ? `${oidWarning} Also removed a $sort whose order was discarded by the following $group (no $first/$last used).`
        : 'Removed a $sort whose order was discarded by the following $group (no $first/$last used).',
    };
  }

  // No downstream rule fired. If the ObjectId coercion rewrote literals,
  // surface it as a standalone autofix so the corrected pipeline reaches
  // execution and the warning is recorded on the report.
  if (oidWarning) {
    return {
      ok: false, mode: 'autofix', pipeline: work,
      rule: 'objectid_string_coercion',
      warning: oidWarning,
    };
  }
  return { ok: true };
}

