// Centralised env access. Throws early at first import if anything required is
// missing, so misconfigured deployments fail loudly instead of half-working.
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
  MONGO_URI: req('MONGO_URI'),
  BI_DB: opt('BI_DB', 'bi'),
  DATA_DB: opt('DATA_DB', 'pakleandb'),

  ADMIN_EMAIL: opt('ADMIN_EMAIL', 'admin@paklean.local'),
  ADMIN_PASSWORD: opt('ADMIN_PASSWORD', 'changeme-admin'),

  JWT_SECRET: req('JWT_SECRET'),
  JWT_TTL_HOURS: num('JWT_TTL_HOURS', 12),

  OPENAI_API_KEY: opt('OPENAI_API_KEY', ''),
  OPENAI_MODEL: opt('OPENAI_MODEL', 'gpt-4o-mini'),
  OPENAI_USE_PROXY: opt('OPENAI_USE_PROXY', 'false') === 'true',
  PROXY_TYPE: opt('PROXY_TYPE', 'socks5'),
  PROXY_HOST: opt('PROXY_HOST', '127.0.0.1'),
  PROXY_PORT: num('PROXY_PORT', 8080),

  REPORT_MAX_ROWS: num('REPORT_MAX_ROWS', 1000),
  REPORT_MAX_TIME_MS: num('REPORT_MAX_TIME_MS', 15000),

  EMBEDDING_PROVIDER: (opt('EMBEDDING_PROVIDER', 'none') as 'none' | 'hf' | 'openai'),
  HF_API_KEY: opt('HF_API_KEY', ''),
  HF_EMBEDDING_MODEL: opt('HF_EMBEDDING_MODEL', 'sentence-transformers/all-MiniLM-L6-v2'),
  CACHE_SIMILARITY_THRESHOLD: Number(opt('CACHE_SIMILARITY_THRESHOLD', '0.92')),
  CACHE_TTL_DAYS: num('CACHE_TTL_DAYS', 30),
};
