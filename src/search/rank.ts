const K1 = 1.2;
const B = 0.75;
export const HEADING_BOOST = 1.0;
export const PHRASE_BOOST = 0.5;
export const TF_CAP = 20;

export interface QueryTerms {
  terms: string[];
  phrases: string[];
}

export function queryTerms(query: string): QueryTerms {
  const terms = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
  const phrases: string[] = [];
  if (terms.length >= 2) {
    for (const p of [terms.join(""), terms.join(" ")]) if ([...p].length >= 3 && !phrases.includes(p)) phrases.push(p);
  }
  return { terms, phrases };
}

export const FALSE_FRIENDS: Readonly<Record<string, readonly string[]>> = {
  "리스": ["리스크", "리스트", "크리스", "그리스", "폴리스", "프리스", "리스본"],
  "감사": ["감사합니다", "감사드"],
  "공시": ["공시지가", "공시가격"],
};

function insideFalseFriend(haystack: string, i: number, needle: string): boolean {
  for (const f of FALSE_FRIENDS[needle] ?? []) {
    const k = f.indexOf(needle);
    if (i - k >= 0 && haystack.startsWith(f, i - k)) return true;
  }
  return false;
}

export function findTerm(haystack: string, needle: string, from = 0): number {
  if (!needle) return -1;
  if (!FALSE_FRIENDS[needle]) return haystack.indexOf(needle, from);
  for (let i = haystack.indexOf(needle, from); i >= 0; i = haystack.indexOf(needle, i + 1)) {
    if (!insideFalseFriend(haystack, i, needle)) return i;
  }
  return -1;
}

export function hasTerm(haystack: string, needle: string): boolean {
  return findTerm(haystack, needle) >= 0;
}

export function idf(df: number, total: number): number {
  return Math.log(1 + (total - df + 0.5) / (df + 0.5));
}

export interface RankStats {
  idf: Map<string, number>;
  avgLen: number;
}

export interface DocSignals {
  tf: number[];
  len: number;
  head: string;
  phraseInBody: boolean;
}

export function relevance(q: QueryTerms, stats: RankStats, d: DocSignals): number {
  const norm = 1 - B + (B * d.len) / Math.max(1, stats.avgLen);
  let score = 0;
  let idfSum = 0;
  q.terms.forEach((t, i) => {
    const w = stats.idf.get(t) ?? 0;
    idfSum += w;
    const tf = d.tf[i] ?? 0;
    score += (w * tf * (K1 + 1)) / (tf + K1 * norm);
    if (hasTerm(d.head, t)) score += w * HEADING_BOOST;
  });
  if (d.phraseInBody) score += idfSum * PHRASE_BOOST;
  if (d.head && q.phrases.some((p) => d.head.includes(p))) score += idfSum * PHRASE_BOOST;
  return score;
}

export function makeSnippet(
  text: string, q: QueryTerms, stats: Pick<RankStats, "idf">, open = "[", close = "]", before = 14, after = 30,
): string | null {
  const lower = text.toLowerCase();
  let at = -1;
  let len = 0;
  for (const p of q.phrases) {
    const i = lower.indexOf(p);
    if (i >= 0) { at = i; len = p.length; break; }
  }
  if (at < 0) {
    const byIdf = [...q.terms].sort((a, b) => (stats.idf.get(b) ?? 0) - (stats.idf.get(a) ?? 0));
    for (const t of byIdf) {
      const i = findTerm(lower, t);
      if (i >= 0) { at = i; len = t.length; break; }
    }
  }
  if (at < 0) return null;
  const start = Math.max(0, at - before);
  const end = Math.min(text.length, at + len + after);
  const mark = new Array<boolean>(end - start).fill(false);
  for (const t of q.terms) {
    for (let i = findTerm(lower, t, start); i >= 0 && i < end; i = findTerm(lower, t, i + t.length))
      mark.fill(true, i - start, Math.min(i + t.length, end) - start);
  }
  let out = "";
  for (let i = 0; i < mark.length; i++) {
    if (mark[i] && (i === 0 || !mark[i - 1])) out += open;
    out += text[start + i];
    if (mark[i] && (i === mark.length - 1 || !mark[i + 1])) out += close;
  }
  return `${start > 0 ? "…" : ""}${out.replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}
