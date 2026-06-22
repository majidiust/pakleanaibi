// Generate human-readable descriptions for each collection. Uses OpenAI when
// configured; falls back to a deterministic heuristic so the system works
// without an API key.
import OpenAI from 'openai';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { env } from '../env';
import { recordUsage } from '../llm-cost';
import type { FieldSample, IntelCollection } from './types';

interface DescribeInput { name: string; tags: string[]; fields: FieldSample[]; docCount: number }
export interface DescribeOutput { description: string; entity: string }

// ---- Heuristic fallback -----------------------------------------------------

function pickEntity(name: string, tags: string[]): string {
  const lower = name.toLowerCase();
  if (tags.includes('identity')) return 'User';
  if (tags.includes('commerce')) return 'Order';
  if (tags.includes('finance')) return 'Transaction';
  if (tags.includes('business')) return 'Business';
  if (tags.includes('catalog')) return 'Product';
  if (tags.includes('telemetry')) return 'Event';
  if (tags.includes('auth')) return 'Session';
  // Last resort: title-cased singular of the collection name.
  const stem = lower.replace(/ies$/, 'y').replace(/sses$/, 'ss').replace(/s$/, '');
  return stem.charAt(0).toUpperCase() + stem.slice(1);
}

function heuristicDescribe(input: DescribeInput): DescribeOutput {
  const entity = pickEntity(input.name, input.tags);
  const fieldNames = input.fields.map(f => f.path).filter(p => !p.includes('.'));
  const hasUser = fieldNames.some(f => /^userId$|^user_id$|^userid$/i.test(f));
  const hasBiz = fieldNames.some(f => /businessid$/i.test(f));
  const hasWallet = fieldNames.some(f => /walletid$/i.test(f));
  const hasAmount = fieldNames.some(f => /amount|price|value|total/i.test(f));
  const hasStatus = input.fields.some(f => /status|state/i.test(f.path) && f.enumValues);
  const hasTimestamps = input.fields.some(f => f.isTimestamp);

  const refs: string[] = [];
  if (hasUser) refs.push('users');
  if (hasBiz) refs.push('businesses');
  if (hasWallet) refs.push('wallets');
  const refsTxt = refs.length ? ` and references ${refs.join(', ')}` : '';

  const traits: string[] = [];
  if (hasAmount) traits.push('financial amounts');
  if (hasStatus) traits.push('lifecycle status');
  if (hasTimestamps) traits.push('audit timestamps');
  const traitsTxt = traits.length ? `, including ${traits.join(', ')}` : '';

  return {
    entity,
    description: `Stores ${entity.toLowerCase()} records${traitsTxt}${refsTxt}.`,
  };
}

// ---- OpenAI path ------------------------------------------------------------

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (_client) return _client;
  const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey: env.OPENAI_API_KEY };
  if (env.OPENAI_USE_PROXY) {
    const agent = new SocksProxyAgent(`${env.PROXY_TYPE}://${env.PROXY_HOST}:${env.PROXY_PORT}`);
    (opts as { httpAgent?: unknown }).httpAgent = agent;
  }
  _client = new OpenAI(opts);
  return _client;
}

function compactPrompt(collections: DescribeInput[]): string {
  const lines: string[] = [];
  for (const c of collections) {
    const f = c.fields.slice(0, 24).map(x => {
      const t = x.types.join('|');
      const e = x.enumValues ? ` enum:{${x.enumValues.slice(0, 5).join(',')}}` : '';
      return `${x.path}:${t}${e}`;
    }).join(', ');
    lines.push(`- ${c.name} (~${c.docCount} docs, tags=${c.tags.join('|') || 'none'}): ${f}`);
  }
  return lines.join('\n');
}

const SYSTEM = `You are a senior data architect. For each MongoDB collection given as
\`name + sample fields + tags\`, produce a one-sentence description (max 30 words)
explaining what the collection stores in business terms, plus a single PascalCase
\`entity\` label (User, Order, Wallet, Transaction, Business, Product, ...).
Reply ONLY with JSON of the form
{"items":[{"name":"...","entity":"...","description":"..."}, ...]}.`;

const RESP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'entity', 'description'],
        properties: {
          name: { type: 'string' }, entity: { type: 'string' }, description: { type: 'string' },
        },
      },
    },
  },
} as const;

export async function describeCollections(collections: IntelCollection[]):
  Promise<Map<string, DescribeOutput>> {
  const out = new Map<string, DescribeOutput>();
  // Honour locked descriptions and seed the map with their existing values.
  const pending: DescribeInput[] = [];
  for (const c of collections) {
    if (c.descriptionLocked && c.description) {
      out.set(c.name, { description: c.description, entity: c.entity ?? pickEntity(c.name, c.tags) });
      continue;
    }
    pending.push({ name: c.name, tags: c.tags, fields: c.fields, docCount: c.docCount });
  }
  if (pending.length === 0) return out;

  if (!env.OPENAI_API_KEY) {
    for (const p of pending) out.set(p.name, heuristicDescribe(p));
    return out;
  }
  // Batch into a single LLM call to keep cost low; chunk if very large.
  const CHUNK = 30;
  for (let i = 0; i < pending.length; i += CHUNK) {
    const batch = pending.slice(i, i + CHUNK);
    try {
      const t0 = Date.now();
      const resp = await client().chat.completions.create({
        model: env.OPENAI_MODEL, temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: compactPrompt(batch) },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'descriptions', schema: RESP_SCHEMA, strict: false } },
      });
      void recordUsage({
        op: 'intel.describe', model: resp.model ?? env.OPENAI_MODEL,
        promptTokens: resp.usage?.prompt_tokens ?? 0,
        completionTokens: resp.usage?.completion_tokens ?? 0,
        durationMs: Date.now() - t0,
      });
      const content = resp.choices[0]?.message?.content;
      const parsed = content ? JSON.parse(content) as { items: { name: string; entity: string; description: string }[] } : null;
      const seen = new Set<string>();
      for (const it of parsed?.items ?? []) {
        seen.add(it.name);
        out.set(it.name, { description: it.description, entity: it.entity });
      }
      for (const p of batch) if (!seen.has(p.name)) out.set(p.name, heuristicDescribe(p));
    } catch {
      for (const p of batch) out.set(p.name, heuristicDescribe(p));
    }
  }
  return out;
}
