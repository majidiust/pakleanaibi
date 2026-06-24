// Conversational turn runner. Handles META/RECAP and small-talk turns
// (list filters, summarise, explain current report, "what did I ask
// before?", greetings, ack replies) WITHOUT hitting the heavy OpenAI
// agentic pipeline. Routes are decided upstream by classifyTurnType()
// in llm-classifier.ts; this module is invoked only when the turn is
// clearly conversational.
//
// Provider chain, in order:
//   1. Hugging Face router (free under the existing HF_API_KEY) using
//      CONV_MODEL (default Qwen2.5-72B-Instruct — strong Persian).
//   2. OpenAI CONV_FALLBACK_MODEL (default gpt-4o-mini, ~10x cheaper
//      than gpt-4o). Used only when HF fails: timeout, 5xx, parse.
//   3. Canned per-language message. Used only when both providers fail.
//
// We do NOT emit JSON: free-tier 70B models routinely break strict
// schema and would force the fallback chain. The response goes back
// to the client as kind="question" with the model's prose in message,
// which the existing UI already renders as a chat bubble.

import OpenAI from 'openai';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { env } from './env';
import { recordUsage } from './llm-cost';
import type { ChatMessage, LlmReport } from './llm';

let _hf: OpenAI | null = null;
function hfClient(): OpenAI | null {
  if (_hf) return _hf;
  if (!env.CLASSIFIER_API_KEY || !env.CLASSIFIER_API_BASE_URL) return null;
  _hf = new OpenAI({ apiKey: env.CLASSIFIER_API_KEY, baseURL: env.CLASSIFIER_API_BASE_URL });
  return _hf;
}

let _oa: OpenAI | null = null;
function oaClient(): OpenAI | null {
  if (_oa) return _oa;
  if (!env.OPENAI_API_KEY) return null;
  const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey: env.OPENAI_API_KEY };
  if (env.OPENAI_USE_PROXY) {
    const agent = new SocksProxyAgent(`${env.PROXY_TYPE}://${env.PROXY_HOST}:${env.PROXY_PORT}`);
    (opts as { httpAgent?: unknown }).httpAgent = agent;
  }
  _oa = new OpenAI(opts);
  return _oa;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// Compact representation of the previous report for the model. Keeping the
// pipeline as raw JSON would chew through 70B context for marginal value;
// the conversational model only needs to recognise stages, filters, and
// projections — not regenerate them.
function summariseReportForChat(r: LlmReport): string {
  const stages = r.pipeline.map((s, i) => {
    const key = Object.keys(s)[0] ?? '?';
    // For stages that carry user-visible conditions, render the FULL stage
    // JSON. The model is expected to enumerate filter values verbatim from
    // exactly these snippets.
    if (key === '$match' || key === '$addFields' || key === '$project'
      || key === '$group' || key === '$lookup' || key === '$set') {
      return `Stage ${i + 1} (${key}):\n${JSON.stringify(s, null, 2)}`;
    }
    // Lightweight stages get one-liners.
    return `Stage ${i + 1} (${key}): ${JSON.stringify(s[key])}`;
  }).join('\n\n');
  const warn = r.warnings && r.warnings.length > 0
    ? `\n\nWarnings on this report:\n- ${r.warnings.join('\n- ')}`
    : '';
  return [
    `Current report collection: ${r.collection}`,
    `Display: ${r.display.kind}${r.display.title ? ` — ${r.display.title}` : ''}`,
    `Explanation that was shown to the user previously: ${r.explanation}`,
    '',
    'Pipeline stages:',
    stages,
    warn,
  ].join('\n');
}

const CONV_SYSTEM_EN = `You are a friendly senior BI analyst chatting with the user about a
report you produced together. Answer the user's LATEST message based ONLY on
the conversation history and the report summary you are given.

Rules:
- Answer the user. Do NOT ask them another clarifying question — they have
  asked you. If their question is genuinely impossible to answer from what
  you've been given (e.g. they ask about a report that doesn't exist yet),
  say so plainly in one sentence.
- When the user asks for filters / conditions / "what we have" / details /
  summary: LIST every relevant condition from the pipeline as bullets.
  Quote field names, operator names ($eq, $in, $gte, ...) and literal
  values VERBATIM from the pipeline JSON. Preserve ObjectId hexes exactly.
  Enumerate every branch of $switch / $cond / nested $cond — case predicate
  first, then-value after, plus the default branch.
- When the user asks "what did I ask before?" or for a recap: list the user's
  prior requests in order, briefly, in their own words where possible.
- Keep the tone collaborative and concrete. No corporate fluff.
- Match the user's language (English or Persian/Farsi). Keep field names,
  operator names and literal values in their original form regardless.
- Markdown is fine: use bullet lists and short headings. Never wrap your
  whole reply in a code fence.
- DO NOT regenerate or "fix" the pipeline. You are explaining, not editing.
  If the user actually wants a pipeline change they will say so and the
  next turn will be routed to the data path automatically.
- If the previous assistant turn already asked a clarifying question and
  the user just replied "yes" / "list" / "all" / "details" / "summary" or
  any equivalent (incl. Persian "بله" / "همه" / "جزئیات" / "خلاصه"), TREAT
  THAT REPLY AS THE ANSWER and produce the listing immediately. Do not
  ask the same question again — that is a forbidden loop.`;

const CONV_SYSTEM_FA = `${CONV_SYSTEM_EN}

The user's latest message is in Persian/Farsi. Write your reply in Persian
(formal, collaborative). Keep schema field names, $-operators, and literal
values (ObjectId hexes, dates, numbers) verbatim in their original form.`;

interface ConvInput {
  history: ChatMessage[];
  lastReport: LlmReport | null;
  lang: 'fa' | 'en';
}

function buildMessages(input: ConvInput): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const sys = input.lang === 'fa' ? CONV_SYSTEM_FA : CONV_SYSTEM_EN;
  const msgs: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: sys },
  ];
  if (input.lastReport) {
    msgs.push({
      role: 'system',
      content: 'Report you produced earlier in this session (the user is asking about this):\n\n'
        + summariseReportForChat(input.lastReport),
    });
  } else {
    msgs.push({
      role: 'system',
      content: 'No report has been produced yet in this session. If the user asks for a recap, '
        + 'say so plainly and offer to help them describe what they want to see.',
    });
  }
  // Pass the recent chat history through verbatim. The 24-turn cap from the
  // route is already small; no further trimming needed for a 70B model.
  for (const m of input.history) msgs.push({ role: m.role, content: m.content });
  return msgs;
}

interface ConvOutput {
  message: string;
  provider: 'hf' | 'openai' | 'canned';
  model?: string;
}

async function callHf(input: ConvInput): Promise<ConvOutput | null> {
  const c = hfClient();
  if (!c) return null;
  const t0 = Date.now();
  const resp = await withTimeout(
    c.chat.completions.create({
      model: env.CONV_MODEL,
      // Higher temp than the agentic call: this is chat, not pipeline
      // synthesis. Picks better paraphrases and avoids the robotic
      // re-emission pattern that drives the loop bug.
      temperature: 0.6,
      max_tokens: 800,
      messages: buildMessages(input),
    }),
    env.CONV_TIMEOUT_MS,
    'conv-hf',
  );
  const txt = (resp.choices?.[0]?.message?.content ?? '').trim();
  if (!txt) return null;
  void recordUsage({
    op: 'report.conversation', model: resp.model ?? env.CONV_MODEL,
    promptTokens: resp.usage?.prompt_tokens ?? 0,
    completionTokens: resp.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - t0,
  });
  return { message: txt, provider: 'hf', model: resp.model ?? env.CONV_MODEL };
}

async function callOpenAiFallback(input: ConvInput): Promise<ConvOutput | null> {
  const c = oaClient();
  if (!c) return null;
  const t0 = Date.now();
  const resp = await withTimeout(
    c.chat.completions.create({
      model: env.CONV_FALLBACK_MODEL,
      temperature: 0.6,
      max_tokens: 800,
      messages: buildMessages(input),
    }),
    env.CONV_TIMEOUT_MS,
    'conv-openai',
  );
  const txt = (resp.choices?.[0]?.message?.content ?? '').trim();
  if (!txt) return null;
  void recordUsage({
    op: 'report.conversation.fallback', model: resp.model ?? env.CONV_FALLBACK_MODEL,
    promptTokens: resp.usage?.prompt_tokens ?? 0,
    completionTokens: resp.usage?.completion_tokens ?? 0,
    durationMs: Date.now() - t0,
  });
  return { message: txt, provider: 'openai', model: resp.model ?? env.CONV_FALLBACK_MODEL };
}

function cannedMessage(input: ConvInput): ConvOutput {
  const lastUser = [...input.history].reverse().find(m => m.role === 'user')?.content ?? '';
  // No report yet — be explicit about it instead of a generic apology.
  if (!input.lastReport) {
    return {
      message: input.lang === 'fa'
        ? 'هنوز گزارشی در این گفت‌وگو ساخته نشده است. اگر بفرمایید چه چیزی را می‌خواهید ببینید، یک گزارش برایتان آماده می‌کنم.'
        : 'No report has been produced in this conversation yet. Tell me what you\u2019d like to see and I\u2019ll put one together.',
      provider: 'canned',
    };
  }
  // Brutally simple canned recap from lastReport when both providers are
  // down. Better than silence; rarely reached in practice.
  const stages = input.lastReport.pipeline.map(s => Object.keys(s)[0] ?? '?').join(' \u2192 ');
  const filterStage = input.lastReport.pipeline.find(s => Object.keys(s)[0] === '$match');
  const filterPreview = filterStage ? JSON.stringify(filterStage).slice(0, 300) : null;
  const body = input.lang === 'fa'
    ? `این گزارش روی مجموعهٔ \`${input.lastReport.collection}\` اجرا می‌شود.\nمراحل: ${stages}.${filterPreview ? `\nاولین فیلتر: \`${filterPreview}\`` : ''}\n\n(سرویس گفت‌وگو موقتاً در دسترس نیست؛ این یک خلاصهٔ خودکار است. اگر می‌خواهید جزئیات کامل را ببینید، چند لحظه دیگر دوباره بپرسید.)`
    : `This report runs against \`${input.lastReport.collection}\`.\nStages: ${stages}.${filterPreview ? `\nFirst filter: \`${filterPreview}\`` : ''}\n\n(Chat service is temporarily unavailable; this is an auto-summary. Ask again in a moment for the full breakdown.)`;
  return { message: body + (lastUser ? '' : ''), provider: 'canned' };
}

// Public entry point. Tries HF first, then OpenAI fallback, then canned.
// Always resolves; never throws.
export async function runConversationalTurn(input: ConvInput): Promise<ConvOutput> {
  try {
    const r = await callHf(input);
    if (r) return r;
  } catch (e) {
    console.warn('[conversation hf] failed, falling back:', e instanceof Error ? e.message : String(e));
  }
  try {
    const r = await callOpenAiFallback(input);
    if (r) return r;
  } catch (e) {
    console.warn('[conversation openai] failed, using canned:', e instanceof Error ? e.message : String(e));
  }
  return cannedMessage(input);
}
