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
  get OPENAI_USE_PROXY() { return opt('OPENAI_USE_PROXY', 'false') === 'true'; },
  get PROXY_TYPE() { return opt('PROXY_TYPE', 'socks5'); },
  get PROXY_HOST() { return opt('PROXY_HOST', '127.0.0.1'); },
  get PROXY_PORT() { return num('PROXY_PORT', 8080); },

  get REPORT_MAX_ROWS() { return num('REPORT_MAX_ROWS', 1000); },
  get REPORT_MAX_TIME_MS() { return num('REPORT_MAX_TIME_MS', 15000); },

  get EMBEDDING_PROVIDER() { return opt('EMBEDDING_PROVIDER', 'none') as 'none' | 'hf' | 'openai'; },
  get HF_API_KEY() { return opt('HF_API_KEY', ''); },
  get HF_EMBEDDING_MODEL() { return opt('HF_EMBEDDING_MODEL', 'sentence-transformers/all-MiniLM-L6-v2'); },
  get CACHE_SIMILARITY_THRESHOLD() { return Number(opt('CACHE_SIMILARITY_THRESHOLD', '0.92')); },
  get CACHE_TTL_DAYS() { return num('CACHE_TTL_DAYS', 30); },
};
