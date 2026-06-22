import OpenAI from 'openai';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { env } from './env';
import { schemaToPrompt, type SchemaDigest } from './schema';

// ----- OpenAI client (singleton; optional SOCKS5 proxy support) -------------
let _client: OpenAI | null = null;
function client(): OpenAI {
  if (_client) return _client;
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not configured');
  const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey: env.OPENAI_API_KEY };
  if (env.OPENAI_USE_PROXY) {
    const agent = new SocksProxyAgent(`${env.PROXY_TYPE}://${env.PROXY_HOST}:${env.PROXY_PORT}`);
    // openai-node uses undici under the hood; fetch with a custom dispatcher
    // is exposed via the httpAgent option.
    (opts as { httpAgent?: unknown }).httpAgent = agent;
  }
  _client = new OpenAI(opts);
  return _client;
}

// ----- Response shape (validated downstream) --------------------------------
export interface LlmReport {
  collection: string;
  pipeline: Record<string, unknown>[];
  display: {
    kind: 'table' | 'bar' | 'line' | 'pie' | 'area';
    xField?: string;
    yField?: string;
    seriesField?: string;
    title?: string;
  };
  explanation: string;
  warnings?: string[];
}

const SYSTEM = `You are a senior BI analyst. Given a natural-language question and a MongoDB schema digest,
produce a single read-only aggregation pipeline that answers the question.

Language:
- The question may be in any language (English, Persian/Farsi, Arabic, Turkish, ...).
- The schema field and collection names are in English. Map terms from the user's
  language to the closest matching English schema fields. Do NOT translate field
  or collection names in the pipeline — use them exactly as they appear in the schema.
- Write the "explanation" in the SAME language as the user's question. Other JSON
  values (collection name, field names, $-operators) stay in English.

Hard constraints:
- Output JSON only, matching the provided JSON schema.
- "pipeline" MUST be a valid MongoDB aggregation pipeline (array of stages).
- Allowed stages only: $match, $project, $group, $sort, $limit, $skip, $count,
  $addFields, $set, $unset, $unwind, $replaceRoot, $replaceWith, $bucket,
  $bucketAuto, $facet, $sortByCount, $lookup, $densify.
- Forbidden: $out, $merge, $function, $accumulator, $where, $changeStream, any
  evaluation operators. No JavaScript strings.
- Always include an explicit final $limit (<= max rows).
- Prefer $group + $sort + $limit for "top N" questions.
- Use ISO date math via $dateFromString / $dateTrunc when grouping by time.
- Pick fields that actually exist in the schema. Don't invent fields.

Display selection:
- "bar" for category-vs-numeric comparisons; xField = category, yField = number.
- "line" or "area" for time series; xField = date, yField = number.
- "pie" only if there are <= 8 distinct categories.
- Otherwise "table".`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['collection', 'pipeline', 'display', 'explanation'],
  properties: {
    collection: { type: 'string' },
    pipeline: { type: 'array', items: { type: 'object' } },
    display: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['table', 'bar', 'line', 'pie', 'area'] },
        xField: { type: 'string' },
        yField: { type: 'string' },
        seriesField: { type: 'string' },
        title: { type: 'string' },
      },
    },
    explanation: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;

export async function generateReport(question: string, digest: SchemaDigest): Promise<LlmReport> {
  const c = client();
  const resp = await c.chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: 0.1,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'system', content: `Max rows: ${env.REPORT_MAX_ROWS}. Schema digest:\n${schemaToPrompt(digest)}` },
      { role: 'user', content: question },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'report', schema: SCHEMA, strict: false },
    },
  });
  const content = resp.choices[0]?.message?.content;
  if (!content) throw new Error('LLM returned empty response');
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('LLM output was not valid JSON'); }
  return parsed as LlmReport;
}

// ----- Repair / refine ------------------------------------------------------
// Used when a previously generated pipeline either (a) failed during
// MongoDB execution, or (b) the user provided a refinement instruction.

const REPAIR_SYSTEM = `You are a senior BI analyst fixing a broken MongoDB aggregation pipeline.

You will receive:
- The original natural-language question (any language).
- The previous JSON answer you produced (collection, pipeline, display, explanation).
- Either: a runtime error message from MongoDB, OR a refinement instruction from the user.

Diagnose the failure or instruction, then return a CORRECTED full JSON answer
matching the same schema. Follow ALL constraints from the base system message
(allowed stages, no $out / $merge / $function, final $limit, never invent
fields, use exact English schema names, etc.).

When fixing errors, common pitfalls to consider:
- Wrong/non-existent field — pick the closest field from the schema.
- "must be an accumulator object" — use $sum, $avg, $first, $last, $min, $max,
  $push, $addToSet inside $group; never leading whitespace on operators.
- Type mismatch — wrap strings with $toDate, $toInt, etc. as needed.
- $lookup join key mismatch — use ObjectId vs string consistently.
- Date math — use $dateSubtract / $dateTrunc / $dateFromString, never JS Date.

Write the "explanation" in the same language as the question and briefly
describe what was changed and why (1\u20132 sentences).`;

export interface RepairContext {
  question: string;
  previous: LlmReport;
  // Provide exactly one of `error` or `refinement`.
  error?: string;
  refinement?: string;
}

// ----- Conversational relationship discovery ------------------------------
// The assistant takes a focused collection (its fields, examples, current
// description) plus a compact view of every other collection in the database
// and a chat history. It returns the next assistant message AND any
// relationship suggestions it has gathered so far. The user can approve each
// suggestion individually; the assistant keeps asking until it has nothing
// useful left to ask (signals via `done`).

export type ChatRole = 'user' | 'assistant';
export interface ChatMessage { role: ChatRole; content: string }

export interface RelSuggestion {
  source: { collection: string; field: string };
  target: { collection: string; field: string; matchOn?: string };
  type: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many' | 'embedded' | 'soft' | 'derived' | 'chain';
  cardinality?: '1:1' | '1:N' | 'N:1' | 'N:N';
  confidence: number;
  reason: string;
  signals?: string[];
}

export interface DiscoverContext {
  focused: {
    name: string;
    description?: string;
    docCount: number;
    fields: { path: string; types: string[]; presence: number; examples?: unknown[]; arrayOf?: string[] }[];
  };
  others: { name: string; entity?: string; description?: string; idFields: string[]; docCount: number }[];
  existing: { source: string; target: string; type: string; status: string }[];
  history: ChatMessage[];
}

export interface DiscoverReply {
  message: string;
  suggestions: RelSuggestion[];
  done: boolean;
}

const DISCOVER_SYSTEM = `You are a senior data architect helping a user map relationships in their MongoDB database.

You are focused on one collection at a time. The user has written a short description (in any
language) of what the collection represents. Your job is an interactive Q&A:

1. Read the focused collection's fields + examples and the names/identifiers of every other
   collection.
2. Identify candidate foreign-key fields (ObjectIds, *_id, *_ref, embedded references, arrays
   of ids, etc.) AND domain links the user might know (e.g. "transactions belong to the wallet
   referenced by walletId").
3. For each candidate, decide if you already have enough evidence to suggest a relationship.
   If yes, emit it in the "suggestions" array with confidence and reason.
4. If you are unsure about a candidate, DO NOT suggest it; instead ask ONE concise clarifying
   question in the "message" field. Ask about one or two ambiguous fields per turn, not all of
   them.
5. When you believe every plausible foreign key has been covered (suggested, ruled out, or
   confirmed not-a-relationship by the user), set "done": true and write a short summary in
   "message".

Hard rules:
- Output JSON only, matching the supplied JSON schema.
- "message" MUST be in the same language as the user's most recent message. Field and
  collection names stay in English exactly as in the schema.
- "source.collection" MUST equal the focused collection. "target.collection" MUST be one of
  the listed other collections (never invent a collection name).
- "source.field" / "target.field" MUST exist in the supplied schema (use dot notation for
  nested fields).
- Each "suggestions" entry should be NEW (the user has not yet seen it in this conversation),
  or a refinement requested by the user. Do not repeat suggestions the user already
  approved/rejected.
- "confidence" is 0-100 based on evidence: ObjectId-typed FK with matching name -> 80-95;
  soft string/number FK with strong naming -> 50-75; user confirmation -> 90-100;
  speculative -> 30-50 (and you should usually ASK instead of suggesting).
- "reason" is one sentence in the user's language explaining the evidence.`;

const DISCOVER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'suggestions', 'done'],
  properties: {
    message: { type: 'string' },
    done: { type: 'boolean' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['source', 'target', 'type', 'confidence', 'reason'],
        properties: {
          source: {
            type: 'object', additionalProperties: false, required: ['collection', 'field'],
            properties: { collection: { type: 'string' }, field: { type: 'string' } },
          },
          target: {
            type: 'object', additionalProperties: false, required: ['collection', 'field'],
            properties: {
              collection: { type: 'string' }, field: { type: 'string' },
              matchOn: { type: 'string' },
            },
          },
          type: { type: 'string', enum: ['one-to-one','one-to-many','many-to-one','many-to-many','embedded','soft','derived','chain'] },
          cardinality: { type: 'string', enum: ['1:1','1:N','N:1','N:N'] },
          confidence: { type: 'number' },
          reason: { type: 'string' },
          signals: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

function contextToPrompt(ctx: DiscoverContext): string {
  const f = ctx.focused;
  const fields = f.fields.map(x => {
    const t = x.arrayOf ? `array<${x.arrayOf.join('|')}>` : x.types.join('|');
    const ex = x.examples?.length ? `  examples=${JSON.stringify(x.examples.slice(0, 2))}` : '';
    return `  - ${x.path}: ${t} (presence=${(x.presence * 100).toFixed(0)}%)${ex}`;
  }).join('\n');
  const others = ctx.others.map(o =>
    `  - ${o.name}${o.entity ? ` [${o.entity}]` : ''} (~${o.docCount} docs)  ids=${o.idFields.join(',') || '_id'}`
    + (o.description ? `\n    desc: ${o.description}` : ''),
  ).join('\n');
  const existing = ctx.existing.length
    ? ctx.existing.map(e => `  - ${e.source} -> ${e.target} (${e.type}, ${e.status})`).join('\n')
    : '  (none)';
  return [
    `Focused collection: ${f.name} (~${f.docCount} docs)`,
    f.description ? `User-provided description:\n  ${f.description}` : 'User-provided description: (empty)',
    `Fields:\n${fields || '  (none)'}`,
    `Other collections in the database:\n${others || '  (none)'}`,
    `Existing approved/manual relationships involving this collection:\n${existing}`,
  ].join('\n\n');
}

export async function discoverRelationshipsFromConversation(ctx: DiscoverContext): Promise<DiscoverReply> {
  const c = client();
  const resp = await c.chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: DISCOVER_SYSTEM },
      { role: 'system', content: contextToPrompt(ctx) },
      ...ctx.history.map(m => ({ role: m.role, content: m.content })),
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'discover', schema: DISCOVER_SCHEMA, strict: false },
    },
  });
  const content = resp.choices[0]?.message?.content;
  if (!content) throw new Error('LLM returned empty response');
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('LLM output was not valid JSON'); }
  const out = parsed as DiscoverReply;
  // Defensive defaults.
  out.suggestions = Array.isArray(out.suggestions) ? out.suggestions : [];
  out.done = !!out.done;
  out.message = String(out.message ?? '');
  return out;
}

// ----- Agentic (multi-turn) reporting -------------------------------------
// One turn of a conversation that ultimately produces an LlmReport. The
// assistant decides whether it has enough information to emit a final
// pipeline (kind='report') or needs to ask one clarifying question
// (kind='question'). It may also revise a previously emitted report when
// the user asks for changes.

export interface AgenticTurn {
  kind: 'question' | 'report';
  message: string;       // Free-form text shown in the chat panel.
  report?: LlmReport;    // Present iff kind='report'.
}

const AGENTIC_SYSTEM = `You are a senior BI analyst running an interactive reporting session over a
MongoDB database. Each turn you receive: the schema digest, the full chat
history, and (optionally) the last report you produced.

Your job, per turn, is to decide ONE of:
  (a) Ask the user ONE focused clarifying question because the request is
      ambiguous (time range unclear, grouping unclear, metric unclear,
      which collection/entity, filter values, etc.). Output kind="question"
      with an actual interrogative sentence in "message" (ends with "?").
      Do NOT include a report.
  (b) Produce or revise a final read-only aggregation pipeline because you
      have enough information. Output kind="report" AND the full "report"
      object with collection, pipeline, display, explanation. Put a short
      ACK / summary (not a question) in "message".

CRITICAL output rules:
- If kind="report", the "report" object is MANDATORY and must include all
  of: collection (string), pipeline (non-empty array), display (object
  with a "kind" enum value), explanation (string). Never produce kind=
  "report" without a populated "report" object.
- If kind="question", do NOT include a report.
- "message" must NEVER be a narration of intent like "Retrieving …" or
  "Let me fetch …". Either ask a real question or ship the report.

Rules for choice:
- Prefer asking when more than one reasonable interpretation exists and the
  difference materially changes the result. Otherwise produce the report
  and explain assumptions in "message".
- Ask AT MOST one question per turn. Keep it under ~25 words.
- After the user has answered enough to disambiguate, switch to producing
  the report — do not keep asking.
- When the user follows up on an existing report ("change to weekly",
  "filter only Iran", "show as bar chart"), revise the previous report and
  return kind="report".

Constraints on report output (when kind="report"):
- "collection" and field names must exist in the schema (English, exact).
- Allowed stages only: $match, $project, $group, $sort, $limit, $skip,
  $count, $addFields, $set, $unset, $unwind, $replaceRoot, $replaceWith,
  $bucket, $bucketAuto, $facet, $sortByCount, $lookup, $densify.
- Forbidden: $out, $merge, $function, $accumulator, $where, evaluation
  operators. No JavaScript strings.
- Always include an explicit final $limit (<= max rows).
- For time-based filters and groupings, ALWAYS respect the "Target MongoDB
  server" capability block below — older servers do not have $dateSubtract,
  $dateTrunc, $$NOW, etc. Prefer literal ISO date strings for cutoffs and
  $dateToString format codes for time buckets when in doubt.
- Pick a display.kind that matches the shape ("bar" / "line" / "pie" /
  "area" / "table") with appropriate xField / yField.

PIPELINE PLANNING (read carefully — this prevents timeouts):
- Identify the ANCHOR collection: the one whose filter is most selective
  (e.g. "the last order this month" = 1 row out of orders). The anchor
  goes in "collection", and the pipeline MUST narrow it first.
- "Anchor first, filter early, join late." Order of stages should always
  be roughly:
    1. $match on anchor fields (date ranges, status, ids).
    2. $sort + $limit if the request is "the last/latest/top N".
    3. $lookup to bring in related rows (use a JOIN RECIPE from the
       schema digest; do NOT invent join keys).
    4. $unwind (only after the anchor has been narrowed).
    5. $project / $group / final $limit.
- NEVER start with $lookup on a large collection and then $match on the
  joined field — that scans the entire anchor and joins every row before
  filtering. The query will time out. Instead, ANCHOR ON THE COLLECTION
  THE FILTER BELONGS TO and use the reverse JOIN RECIPE.
- Concrete example for "items of the last order this month":
    WRONG (timeout):
      collection: "orderitems"
      [ $lookup orders, $unwind, $match on joined date, $sort, $limit ]
    RIGHT (fast):
      collection: "orders"
      [ $match {dCreateDate in this month}, $sort {dCreateDate:-1},
        $limit 1, $lookup orderitems via the reverse recipe,
        $project the item array, $limit ]
- Use the JOIN RECIPES section in the schema digest verbatim. If a
  recipe doesn't exist for the two collections involved, the agent does
  NOT have permission to invent one — ask a clarifying question.

Self-repair mode:
- The system message may contain a "Pending execution error" block. That
  is a MongoDB runtime error from the previous report you produced. Your
  job for that turn is to diagnose and emit a CORRECTED full report
  (kind="report"). Do NOT ask the user a question while a pending error
  is present unless the schema genuinely cannot satisfy the request.
- The user themselves may also paste an error into the chat. Treat that
  the same way — repair the previous report.
- Common pitfalls to consider when repairing:
    * Wrong/non-existent field → pick the closest field from the schema.
    * "must be an accumulator object" → use $sum/$avg/$first/$last/$min/
      $max/$push/$addToSet inside $group; no leading whitespace on $ops.
    * Type mismatch → wrap with $toDate, $toInt, $toString, etc.
    * $lookup join key mismatch → align ObjectId vs string types.
    * Date math → pick operators allowed by the target server version
      (see capability block). On 3.x/4.0 use literal ISO date strings
      and $dateToString format codes; on 5.0+ $dateSubtract/$dateTrunc.
    * "unsupported_operator: …" / "Unrecognized expression …" → the
      operator does not exist on this server version — rewrite using
      the alternatives listed in the capability block.
- In "message" briefly explain (one sentence) what was changed and why.

Language:
- "message" MUST be in the same language as the user's most recent message
  (Persian/Farsi, Arabic, English, ...). Field, collection and operator
  names stay in English as in the schema.`;

const AGENTIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'message'],
  properties: {
    kind: { type: 'string', enum: ['question', 'report'] },
    message: { type: 'string' },
    report: {
      type: 'object',
      additionalProperties: false,
      required: ['collection', 'pipeline', 'display', 'explanation'],
      properties: {
        collection: { type: 'string' },
        pipeline: { type: 'array', items: { type: 'object' } },
        display: {
          type: 'object',
          additionalProperties: false,
          required: ['kind'],
          properties: {
            kind: { type: 'string', enum: ['table', 'bar', 'line', 'pie', 'area'] },
            xField: { type: 'string' },
            yField: { type: 'string' },
            seriesField: { type: 'string' },
            title: { type: 'string' },
          },
        },
        explanation: { type: 'string' },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
  },
} as const;

export interface AgenticContext {
  history: ChatMessage[];
  lastReport?: LlmReport | null;
  pendingError?: string | null;
  serverVersion?: { major: number; minor: number; raw: string } | null;
}

// Per-version capability hints injected as a system message so the model
// avoids operators the target server cannot evaluate. Keep this terse;
// the validator/lowering layer is the source of truth.
function versionCapsBlock(v?: { major: number; minor: number; raw: string } | null): string {
  if (!v) return '';
  const ge = (M: number, m: number) => v.major > M || (v.major === M && v.minor >= m);
  const lines: string[] = [`Target MongoDB server: ${v.raw} (treat as ${v.major}.${v.minor}).`];
  if (!ge(4, 2)) lines.push('- $$NOW and $$CLUSTER_TIME are NOT available.');
  if (!ge(5, 0)) lines.push('- $dateSubtract, $dateAdd, $dateDiff, $dateTrunc are NOT available. For time bucketing use $dateToString with format strings (e.g. "%Y-%m" for monthly, "%Y-%m-%d" for daily).');
  if (!ge(4, 0)) lines.push('- $lookup with "let"+"pipeline" syntax is NOT available; use the simple localField/foreignField form.');
  if (!ge(3, 6)) lines.push('- $expr is NOT available.');
  return lines.join('\n');
}

// Critical date-handling block. The LLM has no clock of its own, so the
// current time has to be injected every turn. BSON Date fields can ONLY be
// compared against real BSON dates -- a string ISO date used as the right
// hand side of $gte against a Date field silently matches nothing on 3.4
// due to BSON type bracketing. We require EJSON {"$date": "..."} form for
// every date literal; the pipeline-guard lowering pass converts those to
// real Date objects before the query reaches MongoDB.
function dateHandlingBlock(): string {
  const now = new Date();
  const iso = now.toISOString();
  const isoMinusN = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  return [
    `Current UTC date/time: ${iso}.`,
    `Common cutoff helpers (precomputed for your convenience -- use ONLY if it matches the requested range exactly, otherwise compute the right one from "Current UTC date/time"):`,
    `  last 24h cutoff: ${isoMinusN(1)}`,
    `  last  7d cutoff: ${isoMinusN(7)}`,
    `  last 30d cutoff: ${isoMinusN(30)}`,
    `  last 90d cutoff: ${isoMinusN(90)}`,
    `  last 365d cutoff: ${isoMinusN(365)}`,
    '',
    'STRICT date-literal rule:',
    '- Whenever a pipeline value represents a date/datetime (any $match filter on a "date"-typed field, any $project expression producing a date, any boundary value), express it as the EJSON object {"$date": "<full ISO-8601 string with Z>"}, NEVER as a bare string.',
    '- Example correct: {"$match": {"dCreateDate": {"$gte": {"$date": "2026-05-23T00:00:00Z"}}}}',
    '- Example WRONG (will silently match nothing on 3.4): {"$match": {"dCreateDate": {"$gte": "2026-05-23T00:00:00Z"}}}',
    '- For "last N days/hours/months", compute the cutoff yourself relative to "Current UTC date/time" above. Do NOT use any cutoff that is older than that (no stale training-data dates).',
  ].join('\n');
}

export async function agenticReport(ctx: AgenticContext, digest: SchemaDigest): Promise<AgenticTurn> {
  const c = client();
  const sysCtx = [
    `Max rows: ${env.REPORT_MAX_ROWS}.`,
    versionCapsBlock(ctx.serverVersion),
    dateHandlingBlock(),
    `Schema digest:\n${schemaToPrompt(digest)}`,
    ctx.lastReport
      ? `Previous report (you may revise this if the user asks):\n${JSON.stringify(ctx.lastReport, null, 2)}`
      : 'No previous report yet in this session.',
    ctx.pendingError
      ? `Pending execution error from the previous report — diagnose and emit a CORRECTED report this turn:\n${ctx.pendingError}`
      : '',
  ].filter(Boolean).join('\n\n');
  const resp = await c.chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: 0.15,
    messages: [
      { role: 'system', content: AGENTIC_SYSTEM },
      { role: 'system', content: sysCtx },
      ...ctx.history.map(m => ({ role: m.role, content: m.content })),
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'agentic_turn', schema: AGENTIC_SCHEMA, strict: false },
    },
  });
  const content = resp.choices[0]?.message?.content;
  if (!content) throw new Error('LLM returned empty response');
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('LLM output was not valid JSON'); }
  const out = parsed as AgenticTurn;
  out.message = String(out.message ?? '');
  if (out.kind === 'report' && !out.report) throw new Error('LLM returned kind=report without a report object');
  return out;
}

export async function repairReport(ctx: RepairContext, digest: SchemaDigest): Promise<LlmReport> {
  const c = client();
  const context = [
    `Original question: ${ctx.question}`,
    `Previous answer (JSON):\n${JSON.stringify(ctx.previous, null, 2)}`,
    ctx.error      ? `MongoDB error:\n${ctx.error}` : '',
    ctx.refinement ? `User refinement instruction (any language):\n${ctx.refinement}` : '',
  ].filter(Boolean).join('\n\n');

  const resp = await c.chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: 0.1,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'system', content: REPAIR_SYSTEM },
      { role: 'system', content: `Max rows: ${env.REPORT_MAX_ROWS}. Schema digest:\n${schemaToPrompt(digest)}` },
      { role: 'user',   content: context },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'report', schema: SCHEMA, strict: false },
    },
  });
  const content = resp.choices[0]?.message?.content;
  if (!content) throw new Error('LLM returned empty response');
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error('LLM output was not valid JSON'); }
  return parsed as LlmReport;
}
