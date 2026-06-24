// Cheap LLM classifier client. Used for refinement-intent detection and
// (in the future) other small "did the user mean X or Y?" decisions where
// burning OpenAI tokens would be wasteful. Any OpenAI-compatible endpoint
// works: Groq, OpenRouter, Together, Gemini's OpenAI-compat URL.
//
// Design choices, in order of priority:
//   1. Safety: any failure (timeout, network, malformed output, missing
//      env) falls back to the keyword-based classifier. The pipeline guard
//      that depends on this signal is no worse off than before.
//   2. Latency: classifier is in the hot path of every refinement turn, so
//      we cap it with a 4s timeout (configurable) and cache by message.
//   3. Cost: a 3B-8B free-tier model can decide local-vs-structural in
//      under 50 input tokens. No JSON schema strict mode (not all free
//      providers support it) -- we parse a one-word answer.

import OpenAI from 'openai';
import { env } from './env';
import { classifyRefinementIntent, type RefinementIntent } from './pipeline-diff';

let _client: OpenAI | null = null;
function client(): OpenAI | null {
  if (_client) return _client;
  if (!env.CLASSIFIER_API_KEY || !env.CLASSIFIER_API_BASE_URL || !env.CLASSIFIER_MODEL) {
    return null;
  }
  _client = new OpenAI({
    apiKey: env.CLASSIFIER_API_KEY,
    baseURL: env.CLASSIFIER_API_BASE_URL,
  });
  return _client;
}

// Bounded LRU keyed by the raw user message. Refinement intent for the
// same instruction never changes, so caching cuts repeat-classifier calls
// to zero when the user is iterating on the same wording.
const CACHE_MAX = 256;
const cache = new Map<string, RefinementIntent>();
function cacheGet(k: string): RefinementIntent | undefined {
  const v = cache.get(k);
  if (v !== undefined) {
    cache.delete(k); cache.set(k, v); // bump recency
  }
  return v;
}
function cacheSet(k: string, v: RefinementIntent): void {
  if (cache.has(k)) cache.delete(k);
  cache.set(k, v);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

const REFINEMENT_PROMPT = `You classify a user instruction that follows an existing aggregation
pipeline. Decide which one of these three labels best describes it,
based on what the user asked the assistant to do to the EXISTING pipeline:

  local       The user is asking for a SMALL targeted edit: rename a
              column, change one filter value, change chart kind, add or
              remove one filter clause, change a sort direction, add a
              conditional branch for a specific id/category, change a
              threshold or limit, switch grouping granularity by ONE step.

  structural  The user is asking for a REWRITE from scratch, a different
              approach, a new query, a redesign, or a fundamentally
              different anchor / collection / join graph.

  ambiguous   You cannot tell from the wording alone, OR the message is
              not a refinement at all (e.g. a meta question like "what
              filters do we have?"), OR it could reasonably be either.

The message may be in English, Persian/Farsi, Arabic, Turkish, etc.
Answer with a SINGLE word: local, structural, or ambiguous. No quotes,
no punctuation, no explanation.`;

// Race a promise against a timeout. Resolves with the inner value on
// success, rejects on timeout. The promise is left to settle in the
// background (no orphan cancellation -- fine for one-shot HTTP calls).
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

function parseLabel(raw: string | null | undefined): RefinementIntent | null {
  if (!raw) return null;
  const m = raw.trim().toLowerCase().match(/local|structural|ambiguous/);
  return (m?.[0] as RefinementIntent | undefined) ?? null;
}

// Public entry point. Returns a refinement intent for the given user
// message. When the classifier client is unconfigured, fails, or times
// out, falls back to the keyword classifier so callers don't have to
// branch on "did the LLM answer or not".
export async function classifyRefinementIntentSmart(message: string): Promise<RefinementIntent> {
  const trimmed = (message || '').trim();
  if (!trimmed) return 'ambiguous';
  const cached = cacheGet(trimmed);
  if (cached) return cached;

  const c = client();
  if (!c) {
    const v = classifyRefinementIntent(trimmed);
    cacheSet(trimmed, v);
    return v;
  }

  try {
    const resp = await withTimeout(
      c.chat.completions.create({
        model: env.CLASSIFIER_MODEL,
        temperature: 0,
        // Bumped from 4 to 12 because some tokenizers (notably Llama
        // family) split "structural" into 2-3 tokens; a too-tight cap
        // returns a truncated label that parseLabel would reject and
        // force a fallback for no good reason.
        max_tokens: 12,
        messages: [
          { role: 'system', content: REFINEMENT_PROMPT },
          { role: 'user', content: trimmed },
        ],
      }),
      env.CLASSIFIER_TIMEOUT_MS,
      'classifier',
    );
    const label = parseLabel(resp.choices?.[0]?.message?.content);
    const v = label ?? classifyRefinementIntent(trimmed);
    cacheSet(trimmed, v);
    return v;
  } catch (e) {
    console.warn('[classifier] falling back to keyword classifier:', e instanceof Error ? e.message : String(e));
    const v = classifyRefinementIntent(trimmed);
    cacheSet(trimmed, v);
    return v;
  }
}
