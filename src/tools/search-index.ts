import type Database from "better-sqlite3";
import { FALSE_FRIENDS, idf, TF_CAP, type DocSignals, type QueryTerms, type RankStats } from "../search/rank.js";

export interface FssDoc {
  ntt_id: number;
  rowid: number;
  date: string;
  head: string;
  buf: Buffer;
  len: number;
}

export interface FssIndex {
  docs: FssDoc[];
  byId: Map<number, FssDoc>;
  avgLen: number;
  df: Map<string, number>;
}

const DF_CACHE_MAX = 5000;

const cache = new WeakMap<Database.Database, FssIndex>();

export function docIndex(db: Database.Database): FssIndex {
  const hit = cache.get(db);
  if (hit) return hit;
  const docs: FssDoc[] = [];
  let total = 0;
  for (const r of db.prepare(`
      SELECT f.rowid AS rowid, f.ntt_id, d.published_at, f.title, f.summary, f.body
      FROM docs_fts f JOIN documents d ON d.ntt_id = f.ntt_id`).iterate() as Iterable<{
        rowid: number; ntt_id: number; published_at: string | null; title: string | null; summary: string | null;
        body: string | null;
      }>) {
    const all = `${r.title ?? ""}\n${r.summary ?? ""}\n${r.body ?? ""}`;
    total += all.length;
    docs.push({
      ntt_id: r.ntt_id, rowid: r.rowid, date: r.published_at ?? "", head: (r.title ?? "").toLowerCase(),
      buf: Buffer.from(all.toLowerCase(), "utf8"), len: all.length,
    });
  }
  const ix: FssIndex = { docs, byId: new Map(docs.map((d) => [d.ntt_id, d])), avgLen: docs.length ? total / docs.length : 1, df: new Map() };
  cache.set(db, ix);
  return ix;
}

export function warmSearchIndex(db: Database.Database): void {
  docIndex(db);
}

const isLong = (t: string): boolean => [...t].length >= 3;

export interface TermMatcher {
  find(buf: Buffer, from?: number): number;
  has(buf: Buffer): boolean;
  count(buf: Buffer, cap: number): number;
}

export function termMatcher(term: string): TermMatcher {
  const needle = Buffer.from(term, "utf8");
  const friends = (FALSE_FRIENDS[term] ?? []).map((f) => ({
    word: Buffer.from(f, "utf8"), skip: Buffer.byteLength(f.slice(0, f.indexOf(term)), "utf8"),
  }));
  const inside = (buf: Buffer, i: number) => friends.some(({ word, skip }) =>
    i - skip >= 0 && i - skip + word.length <= buf.length
    && buf.compare(word, 0, word.length, i - skip, i - skip + word.length) === 0);
  const find = (buf: Buffer, from = 0): number => {
    for (let i = buf.indexOf(needle, from); i >= 0; i = buf.indexOf(needle, i + 1)) if (!inside(buf, i)) return i;
    return -1;
  };
  return {
    find,
    has: (buf) => find(buf) >= 0,
    count: (buf, cap) => {
      let n = 0;
      for (let i = find(buf); i >= 0 && n < cap; i = find(buf, i + needle.length)) n++;
      return n;
    },
  };
}

export function findDocs(
  db: Database.Database, ix: FssIndex, match: string, q: QueryTerms, allowed?: ReadonlySet<number>,
): FssDoc[] {
  let pool: FssDoc[];
  if (match) {
    const ids = db.prepare(`SELECT ntt_id FROM docs_fts WHERE docs_fts MATCH ?`).pluck().all(match) as number[];
    pool = [];
    for (const id of ids) {
      const d = ix.byId.get(id);
      if (d) pool.push(d);
    }
  } else {
    pool = ix.docs;
  }
  const checks = q.terms.filter((t) => !isLong(t) || FALSE_FRIENDS[t]).map(termMatcher);
  const out: FssDoc[] = [];
  for (const d of pool) {
    if (allowed && !allowed.has(d.ntt_id)) continue;
    if (checks.every((m) => m.has(d.buf))) out.push(d);
  }
  return out;
}

export function rankStats(db: Database.Database, ix: FssIndex, q: QueryTerms): RankStats {
  const out = new Map<string, number>();
  for (const t of q.terms) {
    let df = ix.df.get(t);
    if (df === undefined) {
      if (isLong(t) && !FALSE_FRIENDS[t]) {
        df = (db.prepare(`SELECT COUNT(*) AS n FROM docs_fts WHERE docs_fts MATCH ?`)
          .get(`"${t.replace(/"/g, '""')}"`) as { n: number }).n;
      } else {
        const m = termMatcher(t);
        df = 0;
        for (const d of ix.docs) if (m.has(d.buf)) df++;
      }
      if (ix.df.size >= DF_CACHE_MAX) ix.df.clear();
      ix.df.set(t, df);
    }
    out.set(t, idf(df, ix.docs.length));
  }
  return { idf: out, avgLen: ix.avgLen };
}


export const PHRASE_STAGE = 200;

export function rankDocs(
  docs: FssDoc[], q: QueryTerms, stats: RankStats, keep: number,
  relevance: (q: QueryTerms, stats: RankStats, d: DocSignals) => number,
): FssDoc[] {
  const terms = q.terms.map(termMatcher);
  const phrases = q.phrases.map((p) => Buffer.from(p, "utf8"));
  const byScoreThenDate = (a: { d: FssDoc; s: number }, b: { d: FssDoc; s: number }) =>
    b.s - a.s || (a.d.date < b.d.date ? 1 : a.d.date > b.d.date ? -1 : 0);
  const first = docs.map((d) => {
    const sig: DocSignals = { tf: terms.map((m) => m.count(d.buf, TF_CAP)), len: d.len, head: d.head, phraseInBody: false };
    return { d, sig, s: relevance(q, stats, sig) };
  }).sort(byScoreThenDate);
  if (!phrases.length) return first.map((x) => x.d);
  const width = Math.max(PHRASE_STAGE, keep);
  const head = first.slice(0, width).map(({ d, sig }) => {
    const full = { ...sig, phraseInBody: phrases.some((p) => d.buf.indexOf(p) >= 0) };
    return { d, s: relevance(q, stats, full) };
  }).sort(byScoreThenDate);
  return [...head.map((x) => x.d), ...first.slice(width).map((x) => x.d)];
}
