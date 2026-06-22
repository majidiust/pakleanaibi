// Database-agnostic naming utilities used by the relationship engine.
// Pure functions — no I/O, no hardcoded entity vocabularies. Everything that
// looks domain-specific (abbreviation map, FK suffixes) is derived from the
// actual corpus passed in at runtime.

// ----- Tokenisation -------------------------------------------------------
// Splits identifiers written in any common style (camelCase, snake_case,
// PascalCase, kebab-case, ALLCAPS, mixed) into lowercase tokens. Handles
// digit/letter boundaries and acronym runs (e.g. "HTTPSConnection" -> https connection).
const NON_ALNUM = /[^A-Za-z0-9]+/g;

export function tokens(name: string): string[] {
  if (!name) return [];
  let s = String(name);
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');             // camel boundary
  s = s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');          // acronym boundary
  s = s.replace(/([A-Za-z])([0-9])/g, '$1 $2');             // letter -> digit
  s = s.replace(/([0-9])([A-Za-z])/g, '$1 $2');             // digit -> letter
  s = s.replace(NON_ALNUM, ' ');
  return s.toLowerCase().split(/\s+/).filter(Boolean);
}

export function normalize(name: string): string {
  return tokens(name).join('');
}

// ----- Singular / plural --------------------------------------------------
// Best-effort English heuristic. The engine never relies on this being
// perfect: name similarity falls back to fuzzy edit distance when the
// singularised forms still differ.
const IRREGULAR: Record<string, string> = {
  people: 'person', men: 'man', women: 'woman', children: 'child',
  feet: 'foot', teeth: 'tooth', mice: 'mouse', geese: 'goose',
  data: 'datum', media: 'medium', criteria: 'criterion',
};

export function singular(token: string): string {
  if (!token) return token;
  const t = token.toLowerCase();
  if (IRREGULAR[t]) return IRREGULAR[t];
  if (t.length < 3) return t;
  if (t.endsWith('ies') && t.length > 4) return t.slice(0, -3) + 'y';
  if (/(s|x|z|ch|sh)es$/.test(t)) return t.slice(0, -2);    // boxes, churches, businesses
  if (t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) return t.slice(0, -1);
  return t;
}

export function plural(token: string): string {
  if (!token) return token;
  const s = singular(token);
  if (/(s|x|z|ch|sh)$/.test(s)) return s + 'es';
  if (s.endsWith('y') && s.length > 1 && !'aeiou'.includes(s[s.length - 2])) return s.slice(0, -1) + 'ies';
  return s + 's';
}

// ----- Similarity primitives ---------------------------------------------
export function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function lev(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length; if (!b) return a.length;
  const m = a.length, n = b.length;
  const prev = new Array(n + 1).fill(0);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

export function editSim(a: string, b: string): number {
  const L = Math.max(a.length, b.length);
  if (!L) return 1;
  return 1 - lev(a, b) / L;
}

/** How well `short` reads as an abbreviation of `long`. Returns 0..1.
 *  Strong prefixes score very high (`usr` vs `user`); ordered subsequence
 *  matches anchored at the first character score moderately; everything
 *  else returns 0. No hardcoded abbreviation list. */
export function abbrev(short: string, long: string): number {
  if (!short || !long || short.length > long.length) return 0;
  if (short === long) return 1;
  if (long.startsWith(short)) return 0.85 + (short.length / long.length) * 0.15;
  if (short[0] !== long[0]) return 0;
  let i = 0, gaps = 0;
  for (let j = 0; j < long.length && i < short.length; j++) {
    if (long[j] === short[i]) i++;
    else if (i > 0) gaps++;
  }
  if (i !== short.length) return 0;
  const coverage = short.length / long.length;
  const penalty = Math.min(0.4, gaps * 0.05);
  return Math.max(0, coverage - penalty);
}

// ----- Combined name similarity ------------------------------------------
export interface NameMatch { score: number; evidence: string[] }

/** Compare two arbitrary identifiers using token-set similarity, singularised
 *  equality, abbreviation containment, and bounded edit-distance fuzziness.
 *  Operates only on the supplied strings — no external vocabulary. */
export function nameSimilarity(a: string, b: string): NameMatch {
  const ev: string[] = [];
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return { score: 0, evidence: [] };

  const sa = ta.map(singular), sb = tb.map(singular);
  const setA = new Set(sa), setB = new Set(sb);
  const shared = [...setA].filter(t => setB.has(t));
  if (shared.length && shared.length === Math.max(setA.size, setB.size)) {
    return { score: 1, evidence: [`exact singular match (${shared.join(',')})`] };
  }
  if (shared.length) ev.push(`shared tokens: ${shared.join(',')}`);

  const j = jaccard(sa, sb);
  if (j > 0) ev.push(`token jaccard ${(j * 100).toFixed(0)}%`);

  const ja = sa.join(''), jb = sb.join('');
  const e = editSim(ja, jb);
  if (ja !== jb && e >= 0.7) ev.push(`fuzzy edit similarity ${(e * 100).toFixed(0)}%`);

  // Abbreviation only meaningful for short forms.
  let ab = 0;
  for (const x of sa) for (const y of sb) {
    if (x === y) continue;
    ab = Math.max(ab, abbrev(x, y), abbrev(y, x));
  }
  if (ab > 0.6) ev.push(`abbreviation match ${(ab * 100).toFixed(0)}%`);

  // Combine: take the strongest signal; small bonus when several agree.
  const combined = Math.max(j, e * 0.85, ab * 0.8);
  const agree = [j, e, ab].filter(x => x >= 0.6).length;
  const bonus = agree >= 2 ? 0.05 : 0;
  return { score: Math.min(1, combined + bonus), evidence: ev };
}

// ----- Corpus-driven abbreviation inference ------------------------------
/** Scan the supplied corpus (collection names + tokenised field names) and
 *  produce abbreviation→canonical-word mappings supported by the data.
 *  A short token is only mapped to a longer one if (a) the longer form
 *  appears multiple times in the corpus, (b) the short form is a strong
 *  abbreviation of it, and (c) the short form is itself not a freestanding
 *  word in the corpus. */
export function inferAbbreviations(corpus: string[]): Map<string, string> {
  const freq = new Map<string, number>();
  for (const s of corpus) for (const t of tokens(s).map(singular)) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const longs = [...freq.entries()].filter(([t, n]) => t.length >= 4 && n >= 2).map(([t]) => t);
  const shorts = [...freq.keys()].filter(t => t.length >= 2 && t.length <= 4);
  const map = new Map<string, string>();
  for (const s of shorts) {
    if ((freq.get(s) ?? 0) >= 3) continue;            // freestanding word
    let best = ''; let score = 0;
    for (const l of longs) {
      const sc = abbrev(s, l);
      if (sc > score) { score = sc; best = l; }
    }
    if (score >= 0.7) map.set(s, best);
  }
  return map;
}
