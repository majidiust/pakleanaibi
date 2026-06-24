// Centralised env access. Each field is evaluated lazily on first read so that
// importing this module is safe during Next.js's "Collecting page data" phase
// (which runs at `next build` time without runtime env). A misconfigured
// deployment still fails loudly -- but on the first request that needs the
// missing value, not at build time.
function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`env var ${name} is required`);
  return v;
}
function opt(name: string, def: string): string {
  const v = process.env[name];
  return v && v.trim() ? v : def;
}
function num(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// Build a mongodb:// URI from individual components, URL-encoding the
// userinfo so that special characters in the password (e.g. '@', ':', '/')
// don't break the parser. Falls back to MONGO_URI verbatim if components
// aren't provided (keeps the simpler dev path working).
function buildMongoUri(): string {
  const user = process.env.MONGO_USERNAME;
  const pass = process.env.MONGO_PASSWORD;
  const host = process.env.MONGO_HOST;
  if (user && pass && host) {
    const port = process.env.MONGO_PORT ?? '27017';
    const authSource = process.env.MONGO_AUTH_SOURCE ?? 'admin';
    const extra = process.env.MONGO_PARAMS ? `&${process.env.MONGO_PARAMS}` : '';
    return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}` +
      `@${host}:${port}/?authSource=${encodeURIComponent(authSource)}${extra}`;
  }
  return req('MONGO_URI');
}

export const env = {
  get MONGO_URI() { return buildMongoUri(); },
  get BI_DB() { return opt('BI_DB', 'bi'); },
  get DATA_DB() { return opt('DATA_DB', 'pakleandb'); },

  get ADMIN_EMAIL() { return opt('ADMIN_EMAIL', 'admin@paklean.local'); },
  get ADMIN_PASSWORD() { return opt('ADMIN_PASSWORD', 'changeme-admin'); },

  get JWT_SECRET() { return req('JWT_SECRET'); },
  get JWT_TTL_HOURS() { return num('JWT_TTL_HOURS', 12); },

  get OPENAI_API_KEY() { return opt('OPENAI_API_KEY', ''); },
  get OPENAI_MODEL() { return opt('OPENAI_MODEL', 'gpt-4o'); },
  // Output token cap for LLM completions. Long agentic reports (10+ pipeline
  // stages + Persian explanation) routinely exceed the API's small default
  // and get truncated mid-JSON, which produces an unparseable body. gpt-4o /
  // gpt-4o-mini support up to 16384 output tokens; 8000 is a safe headroom.
  get OPENAI_MAX_OUTPUT_TOKENS() { return num('OPENAI_MAX_OUTPUT_TOKENS', 8000); },
  // Total context window for the chosen model (input + output tokens). The
  // request body is fitted under (CONTEXT_WINDOW - MAX_OUTPUT_TOKENS - margin)
  // by trimming the previous-report echo and older history. gpt-4o / gpt-4o-mini
  // / gpt-4.1 all expose 128k; raise this only for models with a larger window.
  get OPENAI_CONTEXT_WINDOW() { return num('OPENAI_CONTEXT_WINDOW', 128000); },
  get OPENAI_USE_PROXY() { return opt('OPENAI_USE_PROXY', 'false') === 'true'; },
  get PROXY_TYPE() { return opt('PROXY_TYPE', 'socks5'); },
  get PROXY_HOST() { return opt('PROXY_HOST', '127.0.0.1'); },
  get PROXY_PORT() { return num('PROXY_PORT', 8080); },

  // Secondary LLM used for cheap classification tasks (refinement intent,
  // etc.) so we don't burn OpenAI tokens on decisions a small free model
  // can make in one shot. Defaults to Hugging Face's OpenAI-compatible
  // router and reuses HF_API_KEY (the same key already used for
  // embeddings); override with any OpenAI-compatible provider by setting
  // the three CLASSIFIER_* env vars explicitly:
  //   CLASSIFIER_API_BASE_URL=https://api.groq.com/openai/v1
  //   CLASSIFIER_MODEL=llama-3.1-8b-instant
  //   CLASSIFIER_API_KEY=<provider key>
  // When no key is available (CLASSIFIER_API_KEY and HF_API_KEY both
  // empty), the classifier silently falls back to the in-process keyword
  // heuristic so deployments without any HF/OpenAI-compat key still work.
  get CLASSIFIER_API_KEY() { return opt('CLASSIFIER_API_KEY', '') || opt('HF_API_KEY', ''); },
  get CLASSIFIER_API_BASE_URL() { return opt('CLASSIFIER_API_BASE_URL', 'https://router.huggingface.co/v1'); },
  get CLASSIFIER_MODEL() { return opt('CLASSIFIER_MODEL', 'meta-llama/Llama-3.1-8B-Instruct'); },
  get CLASSIFIER_TIMEOUT_MS() { return num('CLASSIFIER_TIMEOUT_MS', 4000); },

  // Conversational LLM used for META/RECAP turns and other non-data chat
  // (recap of conditions, "what did I ask before?", clarifying answers,
  // small talk). Runs on the same HF router as the classifier so it costs
  // nothing under the existing HF_API_KEY. Heavier model than the
  // classifier because the OUTPUT must be a coherent paragraph or bullet
  // list, not a single label.
  //   CONV_MODEL                   default Qwen2.5-72B-Instruct (better
  //                                Persian than Llama-3.x)
  //   CONV_FALLBACK_MODEL          OpenAI model used only when the HF
  //                                router fails (timeout, 5xx, quota).
  //                                gpt-4o-mini is ~10x cheaper than
  //                                gpt-4o so a brief outage barely shows
  //                                up on the bill.
  //   CONV_TIMEOUT_MS              cap on a single conversational call.
  get CONV_MODEL() { return opt('CONV_MODEL', 'Qwen/Qwen2.5-72B-Instruct'); },
  get CONV_FALLBACK_MODEL() { return opt('CONV_FALLBACK_MODEL', 'gpt-4o-mini'); },
  get CONV_TIMEOUT_MS() { return num('CONV_TIMEOUT_MS', 8000); },

  get REPORT_MAX_ROWS() { return num('REPORT_MAX_ROWS', 1000); },
  get REPORT_MAX_TIME_MS() { return num('REPORT_MAX_TIME_MS', 15000); },

  get EMBEDDING_PROVIDER() { return opt('EMBEDDING_PROVIDER', 'none') as 'none' | 'hf' | 'openai'; },
  get HF_API_KEY() { return opt('HF_API_KEY', ''); },
  get HF_EMBEDDING_MODEL() { return opt('HF_EMBEDDING_MODEL', 'sentence-transformers/all-MiniLM-L6-v2'); },
  get CACHE_SIMILARITY_THRESHOLD() { return Number(opt('CACHE_SIMILARITY_THRESHOLD', '0.92')); },
  get CACHE_TTL_DAYS() { return num('CACHE_TTL_DAYS', 30); },
};
