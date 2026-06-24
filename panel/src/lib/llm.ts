import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { env } from './env';
import { fitSchemaPrompt, type SchemaDigest } from './schema';
import { recordUsage } from './llm-cost';

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

// ----- Tolerant JSON parsing for LLM outputs --------------------------------
// Strips common wrappers (markdown code fences, "Here is the JSON:" preambles)
// and then JSON.parse. If the body looks truncated (open braces/brackets
// without their close), attempts a one-shot completion of trailing structure
// so a long, otherwise-valid pipeline isn't lost.
function stripJsonWrappers(s: string): string {
  let t = s.trim();
  // ```json ... ``` or ``` ... ```
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  // First '{' or '[' wins -- some models prepend "Sure, here you go:\n".
  const firstObj = t.indexOf('{');
  const firstArr = t.indexOf('[');
  const first = firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
  if (first > 0) t = t.slice(first);
  return t;
}

function tryRepairTruncated(s: string): string | null {
  // Heuristic: count unmatched openers OUTSIDE of strings and append closers.
  // Handles the common case of `"$lt": "2026-06-01T00...` being cut mid-string.
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}') { if (stack[stack.length - 1] === '{') stack.pop(); }
    else if (ch === ']') { if (stack[stack.length - 1] === '[') stack.pop(); }
  }
  if (!inStr && stack.length === 0) return null; // not actually truncated
  let tail = '';
  if (inStr) tail += '"';
  // Trailing comma after the last value is illegal -- drop one if present.
  let head = s.replace(/,\s*$/, '');
  // If we cut in the middle of `"key":` with no value, drop the dangling key.
  head = head.replace(/,\s*"[^"\n]*"\s*:\s*$/, '');
  head = head.replace(/"[^"\n]*"\s*:\s*$/, '');
  while (stack.length) {
    const op = stack.pop()!;
    tail += op === '{' ? '}' : ']';
  }
  return head + tail;
}

class LlmJsonError extends Error {
  constructor(msg: string, public readonly snippet: string, public readonly truncated: boolean) {
    super(msg);
  }
}

// ----- Token budget helpers -------------------------------------------------
// We don't ship tiktoken: it adds ~5MB to the panel bundle for a single
// rough estimate. Instead, count UTF-8 byte cost and approximate with a
// conservative bias (overestimate by ~10%) so we always fit comfortably
// under the model's context window. Real-world drift between this estimate
// and the API tokenizer is <5% for our mixed English/Persian prompts.
function estimateTokens(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
  }
  // ~3.3 bytes/token for ASCII JSON, ~1.5 for CJK/RTL; mid-range with bias.
  return Math.ceil(bytes / 3);
}
type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
function messagesTokens(msgs: Msg[]): number {
  // ~4 tokens framing overhead per message (role tag + delimiters).
  return msgs.reduce((n, m) => n + 4 + estimateTokens(m.content), 0);
}

// Build a compact summary of a previous LlmReport that's safe to drop in
// when the full JSON echo would blow the context window. We keep enough
// to let the model recognise "this is a refinement of the same report"
// (collection + display kind + pipeline stage shape + truncated explanation)
// without re-serialising every $-operator argument.
function summariseReport(r: LlmReport): string {
  const stages = r.pipeline.map(s => Object.keys(s)[0] ?? '?').join(' -> ');
  const expl = r.explanation.length > 400 ? r.explanation.slice(0, 400) + '…' : r.explanation;
  return [
    `collection: ${r.collection}`,
    `display: ${r.display.kind}${r.display.title ? ` (title: ${r.display.title})` : ''}`,
    `pipeline stages: ${stages}`,
    `explanation: ${expl}`,
  ].join('\n');
}

// Progressively trim a message bundle until it fits under inputBudget tokens.
// Trim order is least-to-most useful:
//   1. Replace the full lastReport echo with summariseReport().
//   2. Drop the oldest history turns one by one (always keep the latest user
//      message so the model has something to answer).
// The schema digest and AGENTIC_SYSTEM are treated as inviolable -- without
// them the model can't function. If even an empty history + summarised
// echo doesn't fit, we throw a clear configuration error.
interface FitInput {
  fixed: Msg[];          // AGENTIC_SYSTEM + schema digest + version caps + date rules + max rows
  lastReportEcho: { full: string; summary: string } | null;
  pendingError: Msg | null;
  history: Msg[];
  extra: Msg | null;     // retry instruction, etc.
  inputBudget: number;
}
function fitMessages(input: FitInput): { msgs: Msg[]; trimmed: { droppedHistory: number; summarisedReport: boolean } } {
  const { fixed, pendingError, extra, inputBudget } = input;
  let echoMsg: Msg | null = input.lastReportEcho
    ? { role: 'system', content: `Previous report (you may revise this if the user asks):\n${input.lastReportEcho.full}` }
    : null;
  const history = [...input.history];
  let summarisedReport = false;
  let droppedHistory = 0;
  const assemble = (): Msg[] => {
    const out: Msg[] = [...fixed];
    if (echoMsg) out.push(echoMsg);
    if (pendingError) out.push(pendingError);
    out.push(...history);
    if (extra) out.push(extra);
    return out;
  };
  let msgs = assemble();
  if (messagesTokens(msgs) <= inputBudget) return { msgs, trimmed: { droppedHistory: 0, summarisedReport: false } };

  // Step 1: replace full echo with summary.
  if (input.lastReportEcho) {
    echoMsg = {
      role: 'system',
      content: `Previous report (summarised; ask the user if you need a specific stage):\n${input.lastReportEcho.summary}`,
    };
    summarisedReport = true;
    msgs = assemble();
    if (messagesTokens(msgs) <= inputBudget) return { msgs, trimmed: { droppedHistory, summarisedReport } };
  }

  // Step 2: drop oldest history turns while keeping the most recent user turn.
  const lastUserIdx = (() => {
    for (let i = history.length - 1; i >= 0; i--) if (history[i].role === 'user') return i;
    return -1;
  })();
  while (history.length > 1 && messagesTokens(assemble()) > inputBudget) {
    // Never drop the latest user turn; drop the earliest message instead.
    if (lastUserIdx === 0) break;
    history.shift();
    droppedHistory++;
  }
  msgs = assemble();
  if (messagesTokens(msgs) <= inputBudget) return { msgs, trimmed: { droppedHistory, summarisedReport } };

  // Step 3: drop the echo entirely.
  if (echoMsg) {
    echoMsg = null;
    msgs = assemble();
    if (messagesTokens(msgs) <= inputBudget) return { msgs, trimmed: { droppedHistory, summarisedReport: true } };
  }

  // Still over budget: the fixed prefix (schema digest) is too large for the
  // chosen context window. Surface a clear, actionable error rather than
  // letting OpenAI return a cryptic 400.
  const used = messagesTokens(msgs);
  throw new Error(
    `LLM prompt is too large for the chosen model: fixed system context (schema digest + rules) is ~${used} tokens but the input budget is ${inputBudget}. ` +
    `Reduce OPENAI_MAX_OUTPUT_TOKENS, raise OPENAI_CONTEXT_WINDOW for a larger-window model, or shrink the schema digest (e.g. hide low-signal collections).`,
  );
}

// Compute (inputBudget, clampedOutput) honouring the model's context window.
// We always try to keep the configured max_tokens, but if that would push the
// total past the window we clamp output to the available headroom instead.
// safetyMargin covers the OpenAI tokenizer drift vs our estimator.
function computeBudget(estimatedFixedAndHistory: number): { inputBudget: number; clampedOutput: number } {
  const safetyMargin = 800;
  const window = env.OPENAI_CONTEXT_WINDOW;
  const wantOutput = env.OPENAI_MAX_OUTPUT_TOKENS;
  const remaining = window - estimatedFixedAndHistory - safetyMargin;
  const clampedOutput = Math.max(512, Math.min(wantOutput, remaining));
  const inputBudget = window - clampedOutput - safetyMargin;
  return { inputBudget, clampedOutput };
}

// Build the "Max rows + schema digest" system message under a token budget,
// downgrading from full to compact and finally hiding low-signal collections
// when the digest would not otherwise fit. Returns the rendered text plus a
// short note about any downgrades so the system prompt can disclose them to
// the model (helps it ask the user about a missing collection rather than
// silently hallucinate).
function buildSchemaContext(digest: SchemaDigest, otherFixedTokens: number): string {
  // Reserve room for: AGENTIC_SYSTEM (or SYSTEM/REPAIR_SYSTEM), version caps,
  // date rules, history, lastReport echo, completion, safety. Pass the sum
  // as otherFixedTokens. Whatever's left after the safety/output margin is
  // available for the digest itself.
  const safetyMargin = 800;
  const window = env.OPENAI_CONTEXT_WINDOW;
  const wantOutput = env.OPENAI_MAX_OUTPUT_TOKENS;
  const schemaBudget = Math.max(2000, window - wantOutput - otherFixedTokens - safetyMargin);
  const fitted = fitSchemaPrompt(digest, schemaBudget);
  const header = `Max rows: ${env.REPORT_MAX_ROWS}. Schema digest:`;
  const note = fitted.hiddenCollections.length
    ? `\n\nNOTE: ${fitted.hiddenCollections.length} low-signal collection(s) were hidden from this digest to fit the context window. If the user references a collection you don't see, ask them to name it explicitly.`
    : '';
  return `${header}\n${fitted.prompt}${note}`;
}

// Decode the pipeline-as-string field emitted by the strict-mode schema and
// shape the raw object into an LlmReport. Accepts both the new string form
// AND the legacy array form so a cached/old conversation still works.
function decodeReport(raw: unknown, opName: string): LlmReport {
  const o = (raw ?? {}) as Record<string, unknown>;
  let pipeline: Record<string, unknown>[] = [];
  if (Array.isArray(o.pipeline)) {
    pipeline = o.pipeline as Record<string, unknown>[];
  } else if (typeof o.pipeline === 'string') {
    let inner: unknown;
    try { inner = JSON.parse(o.pipeline); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${opName}: pipeline string is not valid JSON: ${msg}`);
    }
    if (!Array.isArray(inner)) throw new Error(`${opName}: pipeline JSON decoded to ${typeof inner}, expected array`);
    pipeline = inner as Record<string, unknown>[];
  } else {
    throw new Error(`${opName}: pipeline is missing or wrong type (${typeof o.pipeline})`);
  }
  const display = (o.display ?? {}) as Record<string, unknown>;
  const cleanStr = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  return {
    collection: String(o.collection ?? ''),
    pipeline,
    display: {
      kind: (display.kind as LlmReport['display']['kind']) ?? 'table',
      xField: cleanStr(display.xField),
      yField: cleanStr(display.yField),
      seriesField: cleanStr(display.seriesField),
      title: cleanStr(display.title),
    },
    explanation: String(o.explanation ?? ''),
    warnings: Array.isArray(o.warnings) ? (o.warnings as unknown[]).filter((w): w is string => typeof w === 'string') : [],
  };
}

function parseLlmJson(resp: ChatCompletion, opName: string): unknown {
  const choice = resp.choices[0];
  if (!choice) throw new Error(`${opName}: LLM returned no choices`);
  const msg = choice.message as { content?: string | null; refusal?: string | null };
  if (msg.refusal) throw new Error(`${opName}: LLM refused: ${msg.refusal}`);
  const content = msg.content;
  if (!content) throw new Error(`${opName}: LLM returned empty response`);
  const finish = choice.finish_reason;
  const truncated = finish === 'length';
  const cleaned = stripJsonWrappers(content);
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to repair trailing truncation before giving up.
    const repaired = tryRepairTruncated(cleaned);
    if (repaired) {
      try { return JSON.parse(repaired); } catch { /* fall through */ }
    }
    const snippet = cleaned.length > 240 ? cleaned.slice(0, 120) + ' … ' + cleaned.slice(-120) : cleaned;
    const reason = truncated
      ? `output was truncated at the ${env.OPENAI_MAX_OUTPUT_TOKENS}-token cap (finish_reason=length). Raise OPENAI_MAX_OUTPUT_TOKENS or ask for a smaller pipeline`
      : `output was not valid JSON (finish_reason=${finish ?? 'unknown'})`;
    throw new LlmJsonError(`${opName}: ${reason}. Snippet: ${snippet}`, snippet, truncated);
  }
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
- "pipeline" is a JSON-ENCODED STRING whose decoded value is a non-empty array of stage objects. Example: "[{\\"$match\\":{\\"status\\":\\"done\\"}},{\\"$limit\\":1000}]". Escape inner quotes with \\" — do NOT emit a raw array.
- The decoded pipeline MUST be a valid MongoDB aggregation pipeline (array of stages).
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

// Strict-mode compatible schema. Notes:
// - OpenAI Structured Outputs in strict mode requires every property to be
//   listed in `required`. Optional fields use `["<type>", "null"]` and the
//   model emits `null` when absent.
// - The aggregation pipeline is an array of arbitrarily-shaped $-operator
//   objects; strict mode can't represent "any object", so we transport it as
//   a JSON-encoded string and parse it back server-side (the recommended
//   workaround per the Structured Outputs docs).
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['collection', 'pipeline', 'display', 'explanation', 'warnings'],
  properties: {
    collection: { type: 'string' },
    pipeline: {
      type: 'string',
      description: 'A JSON-encoded array of MongoDB aggregation pipeline stages, e.g. \'[{"$match":{"x":1}},{"$limit":100}]\'. Must parse as a JSON array of objects.',
    },
    display: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'xField', 'yField', 'seriesField', 'title'],
      properties: {
        kind: { type: 'string', enum: ['table', 'bar', 'line', 'pie', 'area'] },
        xField: { type: ['string', 'null'] },
        yField: { type: ['string', 'null'] },
        seriesField: { type: ['string', 'null'] },
        title: { type: ['string', 'null'] },
      },
    },
    explanation: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
} as const;

export async function generateReport(question: string, digest: SchemaDigest): Promise<LlmReport> {
  const c = client();
  const sysAndUser: Msg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: question },
  ];
  const otherFixed = messagesTokens(sysAndUser);
  const messages: Msg[] = [
    sysAndUser[0],
    { role: 'system', content: buildSchemaContext(digest, otherFixed) },
    sysAndUser[1],
  ];
  const { clampedOutput } = computeBudget(messagesTokens(messages));
  const t0 = Date.now();
  const resp = await c.chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: 0.1,
    max_tokens: clampedOutput,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'report', schema: SCHEMA, strict: true },
    },
  });
  void recordUsage({
    op: 'report.generate', model: resp.model ?? env.OPENAI_MODEL,
    promptTokens: resp.usage?.prompt_tokens ?? 0,
    completionTokens: resp.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - t0,
  });
  return decodeReport(parseLlmJson(resp, 'report.generate'), 'report.generate');
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
        required: ['source', 'target', 'type', 'cardinality', 'confidence', 'reason', 'signals'],
        properties: {
          source: {
            type: 'object', additionalProperties: false, required: ['collection', 'field'],
            properties: { collection: { type: 'string' }, field: { type: 'string' } },
          },
          target: {
            type: 'object', additionalProperties: false, required: ['collection', 'field', 'matchOn'],
            properties: {
              collection: { type: 'string' }, field: { type: 'string' },
              matchOn: { type: ['string', 'null'] },
            },
          },
          type: { type: 'string', enum: ['one-to-one','one-to-many','many-to-one','many-to-many','embedded','soft','derived','chain'] },
          cardinality: { type: ['string', 'null'], description: 'One of "1:1" | "1:N" | "N:1" | "N:N", or null when unknown.' },
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
  const messages: Msg[] = [
    { role: 'system', content: DISCOVER_SYSTEM },
    { role: 'system', content: contextToPrompt(ctx) },
    ...ctx.history.map(m => ({ role: m.role, content: m.content })),
  ];
  const { clampedOutput } = computeBudget(messagesTokens(messages));
  const t0 = Date.now();
  const resp = await c.chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: clampedOutput,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'discover', schema: DISCOVER_SCHEMA, strict: true },
    },
  });
  void recordUsage({
    op: 'intel.discover', model: resp.model ?? env.OPENAI_MODEL,
    promptTokens: resp.usage?.prompt_tokens ?? 0,
    completionTokens: resp.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - t0,
  });
  const raw = parseLlmJson(resp, 'intel.discover') as DiscoverReply;
  // Strict mode requires the model to emit nullable optional fields
  // explicitly. Coerce nulls back to `undefined` for the downstream UI
  // and drop any cardinality value that isn't one of our canonical labels.
  const allowedCard = new Set(['1:1', '1:N', 'N:1', 'N:N']);
  const suggestions = Array.isArray(raw.suggestions) ? raw.suggestions : [];
  for (const s of suggestions) {
    const t = s.target as RelSuggestion['target'] & { matchOn?: string | null };
    if (t.matchOn === null) delete t.matchOn;
    const c = s as RelSuggestion & { cardinality?: string | null };
    if (c.cardinality === null || (c.cardinality && !allowedCard.has(c.cardinality))) delete c.cardinality;
  }
  return { message: String(raw.message ?? ''), done: !!raw.done, suggestions };
}

// ----- Agentic (multi-turn) reporting -------------------------------------
// One turn of a conversation that ultimately produces an LlmReport. The
// assistant decides whether it has enough information to emit a final
// pipeline (kind='report') or needs to ask one clarifying question
// (kind='question'). It may also revise a previously emitted report when
// the user asks for changes.

// When the agent's clarifying question is fundamentally a date question,
// it can signal the UI to render a Jalali date picker by attaching a
// `needs` hint. The user's response will then arrive in a structured
// format (both Jalali and Gregorian ISO + ObjectId boundary) that the
// agent can drop straight into the pipeline. The hint is optional — a
// plain text question still works.
export interface AgenticNeedsDate {
  type: 'date' | 'dateRange';
  label?: string;       // Short caption shown above the picker.
  field?: string;       // Schema field the date will filter, e.g. "dCreateDate".
}

export interface AgenticTurn {
  kind: 'question' | 'report';
  message: string;       // Free-form text shown in the chat panel.
  report?: LlmReport;    // Present iff kind='report'.
  needs?: AgenticNeedsDate;
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
  of: collection (string), pipeline (JSON-encoded string of stages),
  display (object with a "kind" enum value), explanation (string).
  pipeline is transported as a JSON-encoded STRING, not a raw array —
  example: "[{\\"$match\\":{\\"status\\":\\"done\\"}},{\\"$limit\\":1000}]".
  Escape inner quotes with \\". Never produce kind="report" without a
  populated "report" object.
- If kind="question", set "report" to null.
- Set "needs" to null when the clarifying question is NOT a date pick.
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

CLARIFYING QUESTIONS — WHEN TO ASK (do not silently guess):
You are a senior analyst having a fluent conversation, not a one-shot
translator. Asking ONE precise question is cheaper than running a wrong
report. Ask (kind="question") when ANY of these apply:
- Date column choice is ambiguous: more than one date-shaped field exists
  on the candidate collection (e.g. dCreateDate, dUpdateDate, dPaidDate,
  dCompletedDate). Quote the candidates back and ask which one matches
  "ordered" / "completed" / "paid" / etc.
- The date column the user implied is missing OR its storage format is
  unclear from the digest (no !bsonDate / !dateString / !millis tag).
  Offer to fall back to _id timestamps and confirm.
- A previous filter returned zero rows AND the date column is stored as
  a string (you'll see the !dateString tag): confirm whether to compare
  as ISO string or wrap with $toDate.
- Range boundaries are unclear: "this month" — calendar month UTC vs the
  caller's local timezone (Iran is UTC+03:30), "last month" vs "last 30
  days", inclusive vs exclusive end. When the answer materially changes
  the row count, ask.
- Status/state filter values are not obvious from the schema's enum
  values: "completed orders" could be messageState="done" or status=
  "completed" or isCompleted=true depending on the collection. Ask which
  enum value(s) the user means and quote the observable enum values.
- The user references a NAME (not an ObjectId hex) and more than one
  named entity collection could match: ask which collection.
Do not ask when:
- A single reasonable interpretation exists. Run the report and explain
  the assumption in "message".
- The user already answered the same question earlier in this thread.
- A pending execution error is present (you are in repair mode — fix it,
  don't ask).

DATE-PICKER ASSIST (use whenever the clarification IS a date):
When your clarifying question fundamentally asks the user to PICK A DATE
or a DATE RANGE (not which date column to use — that stays plain text),
add a "needs" object so the UI can render a Jalali date picker beside
your question. This removes the round-trip of Persian-vs-Gregorian
typos and ambiguous month numbers.
  - For a single cutoff/boundary date: needs = { "type": "date",
    "label": "<short caption>", "field": "<schema field name, optional>" }
  - For a start/end range: needs = { "type": "dateRange",
    "label": "<short caption>", "field": "<schema field name, optional>" }
The user's reply will then arrive as a structured message containing:
  • the Jalali date(s) the user clicked (for your context),
  • the equivalent Gregorian ISO-8601 timestamps with Z (use these in
    {"$date": "..."} literals),
  • the equivalent ObjectId hex boundaries (use these in {"$oid": "..."}
    literals when filtering on _id).
Treat that reply as the authoritative answer to your date question and
emit a kind="report" turn — do NOT ask the date again.
Do not use "needs" for non-date questions, and never use it together
with kind="report".

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

USER-ATTACHED FIELD HINTS:
- A user message may end with a block of the form:
    [Attached fields]
    - <collection>.<path> (<type>)
    - …
- These are explicit hints from the analyst about which schema fields
  should drive the query. Treat them as authoritative for field
  selection: prefer them over any other plausible field with a similar
  name, and verify they appear in the schema digest before using them.
- The block itself is metadata, not a question. Do NOT echo it back in
  "message" and do NOT ask the user to confirm it.

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

MULTI-HOP JOINS (read before producing any pipeline):
- Before emitting the pipeline, list every field the user asked for and
  check WHICH COLLECTION owns each one. If a requested field (e.g. an
  item NAME / TITLE / DESCRIPTION) does NOT exist on the anchor or on
  the collection reached by the first $lookup, you MUST chain another
  $lookup to the collection that owns that field.
- For an N-hop request: $lookup hop1 -> $unwind hop1_joined -> $lookup
  hop2 -> $unwind hop2_joined -> ... -> $project. Always preserve the
  intermediate prefix when joining the next hop, e.g.
  "localField": "orderitems_joined.item".
- The CHAINED JOIN RECIPES block in the schema digest already spells
  out the exact stages for every 2-hop path the human-confirmed graph
  supports. Copy a chain recipe verbatim instead of stopping at the
  first $lookup.
- Concrete example for "items of the biggest order this month WITH
  ITEM NAME": the item name is on "items", not "orderitems", so:
    collection: "orders"
    [ $match {dCreateDate this month},
      $sort {<size metric>:-1}, $limit 1,
      $lookup orderitems via reverse recipe,
      $unwind orderitems_joined,
      $lookup items via CHAINED RECIPE (localField:
        "orderitems_joined.item", foreignField: "_id"),
      $unwind items_joined,
      $project { itemName: "$items_joined.name", count:
        "$orderitems_joined.count", price:
        "$orderitems_joined.currentPrice" },
      $limit ]
- NEVER project a raw ObjectId like "items_joined.item" and call it the
  item name. The user wants the resolved label from the far collection.

NAME RESOLUTION (resolve human-readable names to ids BEFORE filtering FKs):
- Users almost always reference entities by NAME ("orders of خشکشویی
  مهرآباد", "items called پیراهن", "customer Sarah"). The corresponding
  column on the anchor is almost always an ID/ObjectId field (e.g.
  "laundry.laundryId", "item", "customer", "*Id", "*_id", "*Ref"). A
  human-readable string placed directly into such a field SILENTLY MATCHES
  ZERO ROWS — Mongo compares an ObjectId column against a string and
  finds nothing.
- Rule: if the user supplied a NAME and the candidate filter field is an
  ID/reference field (objectId-typed, or name ends in Id / _id / Ref /
  matches a JOIN RECIPE localField), you MUST resolve the name through
  the named entity's collection. Two acceptable strategies — pick the
  one that matches an existing JOIN RECIPE:
  (1) ANCHOR ON THE NAMED ENTITY when it is highly selective (single
      named laundry, single named customer, ...):
        collection: "<entity>"
        [ $match {<nameField>: "<the name>"}, $limit 1,
          $lookup <facts> via the reverse JOIN RECIPE
            (localField: "_id", foreignField: "<FK on facts>"),
          $unwind <facts>_joined,
          $match {<facts>_joined.<other filters, e.g. date>: …},
          $project …, $limit ]
  (2) ANCHOR ON THE FACTS and use a NAME->ID $lookup. Filter on the
      *resolved* name field AFTER the lookup, never on the raw FK:
        collection: "<facts>"
        [ $match {<other anchor filters, e.g. date>: …},
          $lookup <entity> via the forward JOIN RECIPE
            (localField: "<FK on facts>", foreignField: "_id"),
          $unwind <entity>_joined,
          $match {<entity>_joined.<nameField>: "<the name>"},
          $project …, $limit ]
- Identify the entity's name field by scanning its schema fields for an
  obvious label column (name, title, label, displayName, fullName, etc.).
  If multiple plausible name fields exist, prefer the one the user is
  likely echoing (Persian text -> a localized name field if present).
- If the name might be partial / inexact, use a case-insensitive regex
  on the name field — { "$regex": "<name>", "$options": "i" } — and note
  the assumption in "message".
- ONLY treat the user-provided string as a literal ObjectId when it is
  visibly a 24-character hex string. Otherwise it is a name and must be
  resolved as above.
- Mirror this same rule when REPAIRING a pipeline: if the previous turn
  filtered an ID field against a non-hex string and returned 0 rows, the
  fix is almost always to insert a NAME->ID $lookup and move the filter
  to the resolved name field.

JSON SHAPE RULES (read carefully — these prevent the most common
auto-repair failures):
- Every MongoDB operator is a CLEAN object key starting with "$" followed
  by letters only ($and, $eq, $gte, $sum, ...). Its arguments live in the
  VALUE, never inside the key. Never produce keys like "$eq:[", "$and:",
  "$gte(", "$eq: [\\"$field\\", v]" — those break Mongo's parser.
- Never use "&" in place of "$". Operators always start with "$".
- An object can only have ONE key per operator. To combine multiple
  conditions, use $and / $or with an ARRAY of sibling objects, each of
  which contains exactly one operator:
    CORRECT: { "$expr": { "$and": [
      { "$gte": ["$dCreateDate", {"$date":"2026-06-01T00:00:00Z"}] },
      { "$eq":  ["$isDeleted", false] },
      { "$eq":  ["$messageState", "done"] }
    ] } }
    WRONG  : { "$expr": { "$and": [ { "$eq":[":false, "$eq":[":"done" ] } }
    WRONG  : { "$expr": { "&and": [...] } }
    WRONG  : { "$and": { "$eq": [...], "$eq": [...] } }   (duplicate key)
- If all conditions filter ordinary indexed fields (no cross-field
  references with $-paths), prefer the simpler $match form WITHOUT
  $expr/$and — operators sit inside the field object:
    { "$match": { "isDeleted": false, "messageState": "done",
                  "dCreateDate": { "$gte": {"$date":"2026-06-01T00:00:00Z"},
                                   "$lt":  {"$date":"2026-07-01T00:00:00Z"} } } }
  This is faster (uses indexes) and structurally harder to mis-emit.
- Boolean and string filter values are plain JSON literals (false, true,
  "done") — never wrap them in $literal unless you need to disambiguate a
  string that itself starts with "$".

ObjectId values (read carefully — silent zero-rows + "Unrecognized
expression" failures both come from getting this wrong):
- An ObjectId LITERAL is always emitted as {"$oid":"<24-hex-lowercase>"}.
  This works in EVERY context — $match field values, $expr / $cond / $eq
  inside $addFields or $project, $lookup join keys after $toObjectId is
  unavailable, anywhere. The server-side guard decodes the wrapper into a
  real BSON ObjectId before execution.
- NEVER compare an _id (or any ObjectId-typed field) against a bare hex
  STRING in any context. BSON type bracketing makes that silently match
  nothing.
    CORRECT (match):    { "$match": { "_id": {"$oid":"5e56456cf900052ed23d692b"} } }
    CORRECT (expr):     { "$eq": ["$items_joined._id", {"$oid":"5e56456cf900052ed23d692b"}] }
    WRONG (zero rows):  { "$eq": ["$items_joined._id", "5e56456cf900052ed23d692b"] }
- NEVER wrap an {"$oid":"..."} literal inside $literal — that hides the
  shorthand from the decoder and the server sees a literal sub-document,
  not an ObjectId.
- The 24-hex string MUST be exactly 24 lowercase a-f / 0-9 characters. If
  the user wrote "5E56456C..." normalise to lowercase before emitting.
- Other BSON shorthands behave the same way: {"$date":"<ISO>"} for BSON
  Dates, {"$numberLong":"..."} for 64-bit ints, {"$numberDouble":"..."}
  for floats when precision matters. The guard auto-decodes all of these,
  so they can appear in ANY context (match or expression).

$project literal values:
- Inside $project, only 0/1 (and false/true) have special meaning
  (exclude/include). Any OTHER bare scalar — a number like 0.5, a string
  like "yes", a constant percentage — is treated as a field path or
  inclusion flag on legacy MongoDB and the column will silently
  disappear from the output rows. To emit a constant, ALWAYS wrap it:
    { "$project": { "share": 0.35, "LSH": { "$literal": 0.5 },
                    "label": { "$literal": "high" } } }
  Here "share" works (LLM 0.35 happens to round-trip on 4.4+) but
  "LSH": 0.5 will be dropped on 3.4 — use $literal to be safe.
- For computed numeric columns (multiplications, sums) keep using
  expression objects like { "$multiply": [...] }; only bare constants
  need the $literal wrapper.

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
    * "Malformed operator key" / "must have exactly one field" /
      "Unrecognized expression '$eq:['" → re-read the JSON SHAPE RULES
      above and REBUILD the affected expression tree from scratch. Do
      not just tweak the broken keys.
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

// Strict-mode shape: every property listed in `required`; optional values
// expressed as nullable. `pipeline` is JSON-encoded because aggregation
// stages have arbitrary $-operator keys and strict mode cannot describe a
// "free-form object" — we decode the string back into an array server-side.
const AGENTIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'message', 'needs', 'report'],
  properties: {
    kind: { type: 'string', enum: ['question', 'report'] },
    message: { type: 'string' },
    needs: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'label', 'field'],
          properties: {
            type: { type: 'string', enum: ['date', 'dateRange'] },
            label: { type: ['string', 'null'] },
            field: { type: ['string', 'null'] },
          },
        },
        { type: 'null' },
      ],
    },
    report: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['collection', 'pipeline', 'display', 'explanation', 'warnings'],
          properties: {
            collection: { type: 'string' },
            pipeline: {
              type: 'string',
              description: 'A JSON-encoded array of MongoDB aggregation pipeline stages. Example: \'[{"$match":{"x":1}},{"$limit":100}]\'.',
            },
            display: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'xField', 'yField', 'seriesField', 'title'],
              properties: {
                kind: { type: 'string', enum: ['table', 'bar', 'line', 'pie', 'area'] },
                xField: { type: ['string', 'null'] },
                yField: { type: ['string', 'null'] },
                seriesField: { type: ['string', 'null'] },
                title: { type: ['string', 'null'] },
              },
            },
            explanation: { type: 'string' },
            warnings: { type: 'array', items: { type: 'string' } },
          },
        },
        { type: 'null' },
      ],
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
// Format the current Jalali (Persian) date for the prompt. Node's Intl
// implementation supports the persian calendar natively (ICU). We expose
// year/month/day as plain numbers plus the canonical Persian month name
// so the agent can pattern-match user phrasing like "خرداد ۱۴۰۵".
const JALALI_MONTHS_FA = [
  'فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور',
  'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند',
];
function currentJalali(): { year: number; month: number; day: number; monthName: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', {
      year: 'numeric', month: 'numeric', day: 'numeric',
    }).formatToParts(new Date());
    const m = Object.fromEntries(parts.map(p => [p.type, p.value])) as { year: string; month: string; day: string };
    const month = Number(m.month);
    return { year: Number(m.year), month, day: Number(m.day), monthName: JALALI_MONTHS_FA[month - 1] ?? String(month) };
  } catch { return null; }
}

function dateHandlingBlock(): string {
  const now = new Date();
  const iso = now.toISOString();
  const isoMinusN = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const jal = currentJalali();
  return [
    `Current UTC date/time: ${iso}.`,
    jal ? `Current Jalali (Persian) date: ${jal.year}/${String(jal.month).padStart(2, '0')}/${String(jal.day).padStart(2, '0')} (${jal.monthName} ${jal.year}).` : '',
    '',
    'JALALI ↔ GREGORIAN CALENDAR:',
    '- Documents in this database store dates in the GREGORIAN (Miladi) calendar as BSON Dates / ISO-8601 strings. Iranian users frequently phrase ranges in the JALALI (Shamsi / Persian) calendar — e.g. "خرداد ۱۴۰۵", "تیر ماه", "دو هفته اخیر", "از ابتدای امسال", "هفته گذشته".',
    '- You MUST convert any Jalali phrase to its Gregorian equivalent before emitting the cutoff. Use the "Current Jalali (Persian) date" above as the anchor for any relative phrasing.',
    '- Jalali month → approximate Gregorian span (use the precise day of crossover when the user gives a specific day):',
    '    ۱ فروردین  ≈ 21 March    · ۱ مهر    ≈ 23 September',
    '    ۱ اردیبهشت ≈ 21 April    · ۱ آبان   ≈ 23 October',
    '    ۱ خرداد    ≈ 22 May      · ۱ آذر    ≈ 22 November',
    '    ۱ تیر      ≈ 22 June     · ۱ دی     ≈ 22 December',
    '    ۱ مرداد    ≈ 23 July     · ۱ بهمن   ≈ 21 January',
    '    ۱ شهریور   ≈ 23 August   · ۱ اسفند  ≈ 20 February',
    '- Persian-digit numerals (۰۱۲۳۴۵۶۷۸۹) and Arabic-Indic (٠١٢٣٤٥٦٧٨٩) are the same as 0-9; "۱۴۰۵" = 1405 (Jalali year).',
    '- Relative phrases resolve against the CURRENT Jalali date: "هفته گذشته"/"last week" = last 7 days, "ماه گذشته" = last 30 days, "امسال" = since the most recent ۱ فروردین, "دو هفته اخیر" = last 14 days.',
    '- When in doubt about which calendar the user meant (e.g. ambiguous "ماه ۶"), ask a clarifying question (kind="question") rather than guessing.',
    '',
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
    '',
    'STORAGE FORMAT — INSPECT BEFORE FILTERING:',
    'The schema digest annotates date-like fields with the actual storage format observed in sampled documents, plus a concrete example value. Pick the filter strategy based on that tag:',
    '- "<field>:date!bsonDate=2026-05-23T08:14:00.000Z" → real BSON Date. Filter directly with {"$gte": {"$date": "..."}}. This is the easy case.',
    '- "<field>:string!dateString=\\"2026-05-23T08:14:00\\"" → date stored as STRING. {"$date": "..."} silently matches nothing here. Two options: (a) compare as a string with a lexicographically-ordered ISO cutoff: {"$gte": "2026-05-23T00:00:00"}, which works because ISO-8601 is sort-stable; or (b) wrap the field with $toDate inside an $addFields stage first, then filter the converted field.',
    '- "<field>:number!millis=1716451200000" → epoch millis as a number. Compare with a numeric cutoff: {"$gte": <millis>} (compute the millis from the current UTC date/time above).',
    '- If a field looks date-related (created/updated/at/date/time in the name) but the digest shows NEITHER a date tag NOR a date-shaped example, do NOT assume the format. Ask the user (kind="question") or fall back to the _id timestamp trick below.',
    '',
    'OBJECTID _id DATE EXTRACTION (the universal fallback):',
    'Every MongoDB ObjectId embeds the document\'s creation timestamp in its first 4 bytes. When no explicit date column exists, OR when the date column is unreliable/sparse/wrong-format, use _id instead:',
    '- Filter "documents created since X" without a date column:',
    '    { "$match": { "_id": { "$gte": {"$oid": "<24-hex of an ObjectId whose timestamp = X>"} } } }',
    '  The driver compares ObjectIds byte-wise and the timestamp is the high-order prefix, so this is index-friendly. Use the EJSON form {"$oid": "..."} for the literal so the driver coerces it to a real ObjectId. Construct the boundary id by appending "0000000000000000" (16 hex zeros) to the 8-hex epoch-seconds of X. Example for 2026-06-01T00:00:00Z (epoch 1748736000 → hex "68424300"): {"$oid": "684243000000000000000000"}.',
    '- Group/project the timestamp out of _id when the user wants to see or bucket by creation date:',
    '    { "$addFields": { "_createdAt": { "$toDate": "$_id" } } }',
    '  ($toDate of an ObjectId returns the embedded BSON Date. Available on 3.6+.) Then $match / $group / $dateToString on "$_createdAt" as if it were a real date column.',
    '- When repairing a failed date filter that returned zero rows, ALWAYS consider switching to the _id strategy. It is the most reliable creation-time signal in this database.',
    '- Caveat: _id reflects DOCUMENT CREATION, not "order placed" or "shipment made". If the user\'s intent is a business event with its own timestamp field, prefer that field; only fall back to _id when nothing better exists or when the named date column is broken.',
  ].join('\n');
}

export async function agenticReport(ctx: AgenticContext, digest: SchemaDigest): Promise<AgenticTurn> {
  const c = client();
  // Compute the schema digest budget after subtracting everything else fixed
  // (AGENTIC_SYSTEM + version caps + date rules + history + lastReport echo).
  // The schema is the single largest piece on most installs, so giving it an
  // explicit budget (rather than a hard string) is what keeps us inside the
  // 128k window when the user has many collections.
  const versionCaps = versionCapsBlock(ctx.serverVersion);
  const dateHandling = dateHandlingBlock();
  const lastReportEcho = ctx.lastReport
    ? { full: JSON.stringify(ctx.lastReport, null, 2), summary: summariseReport(ctx.lastReport) }
    : null;
  const pendingError: Msg | null = ctx.pendingError
    ? { role: 'system', content: `Pending execution error from the previous report — diagnose and emit a CORRECTED report this turn:\n${ctx.pendingError}` }
    : null;
  const history: Msg[] = ctx.history.map(m => ({ role: m.role, content: m.content }));

  // Token cost of everything except the schema digest itself.
  const nonSchemaFixed = estimateTokens(AGENTIC_SYSTEM) + estimateTokens(versionCaps) + estimateTokens(dateHandling) + 24;
  const nonSchemaVariable = messagesTokens(history)
    + (pendingError ? messagesTokens([pendingError]) : 0)
    + (lastReportEcho ? estimateTokens(lastReportEcho.full) + 8 : 0);
  const schemaCtx = buildSchemaContext(digest, nonSchemaFixed + nonSchemaVariable);

  const fixed: Msg[] = [
    { role: 'system', content: AGENTIC_SYSTEM },
    ...(versionCaps ? [{ role: 'system' as const, content: versionCaps }] : []),
    { role: 'system', content: dateHandling },
    { role: 'system', content: schemaCtx },
  ];

  // Two-pass: if the first response is truncated, retry once with the prior
  // truncated body as context and a terse instruction to emit a more compact
  // pipeline. Long $project blocks are the usual culprit.
  async function call(extraText?: string): Promise<AgenticTurn> {
    const extra: Msg | null = extraText ? { role: 'system', content: extraText } : null;
    // Estimate the floor (fixed + history + small overhead) to derive a
    // realistic output cap, then fit the variable pieces into the remainder.
    const floor = messagesTokens(fixed) + messagesTokens(history) + (pendingError ? messagesTokens([pendingError]) : 0);
    const { inputBudget, clampedOutput } = computeBudget(floor);
    const { msgs } = fitMessages({ fixed, lastReportEcho, pendingError, history, extra, inputBudget });
    const t0 = Date.now();
    const resp = await c.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0.15,
      max_tokens: clampedOutput,
      messages: msgs,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'agentic_turn', schema: AGENTIC_SCHEMA, strict: true },
      },
    });
    void recordUsage({
      op: 'report.agentic', model: resp.model ?? env.OPENAI_MODEL,
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      completionTokens: resp.usage?.completion_tokens ?? 0,
      durationMs: Date.now() - t0,
    });
    // Strict-mode payload: `report` and `needs` are nullable, and the
    // nested report.pipeline is a JSON-encoded string. Decode + coerce
    // back into the historic AgenticTurn shape the rest of the app
    // expects (`report: LlmReport | undefined`, `needs: ... | undefined`).
    const raw = parseLlmJson(resp, 'report.agentic') as {
      kind: 'question' | 'report';
      message: string;
      needs: AgenticTurn['needs'] | null;
      report: unknown | null;
    };
    const turn: AgenticTurn = {
      kind: raw.kind,
      message: String(raw.message ?? ''),
    };
    if (raw.needs && typeof raw.needs === 'object') turn.needs = raw.needs;
    if (raw.report && typeof raw.report === 'object') {
      turn.report = decodeReport(raw.report, 'report.agentic');
    }
    return turn;
  }
  let out: AgenticTurn;
  try {
    out = await call();
  } catch (e) {
    if (e instanceof LlmJsonError && e.truncated) {
      out = await call(
        'PREVIOUS_ATTEMPT_WAS_TRUNCATED: your last response exceeded the output token cap and was discarded. Re-emit a strictly valid JSON answer. Keep the pipeline focused: prefer a shorter $project (only fields the user asked for), drop optional warnings, and keep the explanation under 4 sentences.',
      );
    } else throw e;
  }
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

  const otherFixed = estimateTokens(SYSTEM) + estimateTokens(REPAIR_SYSTEM) + estimateTokens(context) + 16;
  const messages: Msg[] = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: REPAIR_SYSTEM },
    { role: 'system', content: buildSchemaContext(digest, otherFixed) },
    { role: 'user',   content: context },
  ];
  const { clampedOutput } = computeBudget(messagesTokens(messages));
  const t0 = Date.now();
  const resp = await c.chat.completions.create({
    model: env.OPENAI_MODEL,
    temperature: 0.1,
    max_tokens: clampedOutput,
    messages,
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'report', schema: SCHEMA, strict: true },
    },
  });
  void recordUsage({
    op: 'report.repair', model: resp.model ?? env.OPENAI_MODEL,
    promptTokens: resp.usage?.prompt_tokens ?? 0,
    completionTokens: resp.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - t0,
  });
  return decodeReport(parseLlmJson(resp, 'report.repair'), 'report.repair');
}
