import { env } from './env';

// Pluggable embedding provider used only by the report cache to find
// semantically-similar past questions. Keeping the interface tiny so we can
// drop a different backend in without touching cache.ts.

export interface EmbeddingResult { vector: number[]; model: string }

export function isEmbeddingEnabled(): boolean {
  if (env.EMBEDDING_PROVIDER === 'none') return false;
  if (env.EMBEDDING_PROVIDER === 'hf') return !!env.HF_API_KEY;
  if (env.EMBEDDING_PROVIDER === 'openai') return !!env.OPENAI_API_KEY;
  return false;
}

export async function embed(text: string): Promise<EmbeddingResult | null> {
  if (!isEmbeddingEnabled()) return null;
  const trimmed = text.trim().slice(0, 4000);
  if (env.EMBEDDING_PROVIDER === 'hf') return embedHF(trimmed);
  if (env.EMBEDDING_PROVIDER === 'openai') return embedOpenAI(trimmed);
  return null;
}

// HuggingFace Inference API -- free tier. The pipeline returns either
// `number[]` (single sentence) or `number[][]` (batch). We accept both.
async function embedHF(text: string): Promise<EmbeddingResult | null> {
  const url = `https://api-inference.huggingface.co/pipeline/feature-extraction/${env.HF_EMBEDDING_MODEL}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${env.HF_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ inputs: text, options: { wait_for_model: true } }),
    });
    if (!r.ok) return null;
    const data: unknown = await r.json();
    const vec = Array.isArray(data) && Array.isArray((data as unknown[])[0])
      ? (data as number[][])[0]
      : (data as number[]);
    if (!Array.isArray(vec) || vec.some(v => typeof v !== 'number')) return null;
    return { vector: vec, model: env.HF_EMBEDDING_MODEL };
  } catch {
    return null;
  }
}

async function embedOpenAI(text: string): Promise<EmbeddingResult | null> {
  try {
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    });
    if (!r.ok) return null;
    const data = await r.json() as { data?: { embedding: number[] }[] };
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) return null;
    return { vector: vec, model: 'text-embedding-3-small' };
  } catch {
    return null;
  }
}

export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
