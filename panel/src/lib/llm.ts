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
