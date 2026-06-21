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

export const env = {
  get MONGO_URI() { return req('MONGO_URI'); },
  get BI_DB() { return opt('BI_DB', 'bi'); },
  get DATA_DB() { return opt('DATA_DB', 'pakleandb'); },

  get ADMIN_EMAIL() { return opt('ADMIN_EMAIL', 'admin@paklean.local'); },
  get ADMIN_PASSWORD() { return opt('ADMIN_PASSWORD', 'changeme-admin'); },

  get JWT_SECRET() { return req('JWT_SECRET'); },
  get JWT_TTL_HOURS() { return num('JWT_TTL_HOURS', 12); },

  get OPENAI_API_KEY() { return opt('OPENAI_API_KEY', ''); },
  get OPENAI_MODEL() { return opt('OPENAI_MODEL', 'gpt-4o-mini'); },
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
