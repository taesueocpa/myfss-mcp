import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { splitQuery } from "../search/query.js";
import { makeSnippet, queryTerms, relevance } from "../search/rank.js";
import { BOARD_KEY, BOARD_PARAM_VALUES, decorate, type DocRow } from "./doc-shared.js";
import { docIndex, findDocs, rankDocs, rankStats } from "./search-index.js";

const NOTE = "수록 문서는 2010년 이후 회계·공시 자료 (2010년 이전 구문서는 미수록)";

export const searchDocuments = defineTool({
  name: "search_documents",
  title: "회계·공시 자료 전문검색",
  summary: "금융감독원(FSS)·금융위원회(FSC) 회계·공시 자료를 전문검색합니다.",
  purpose: `- What 감독당국 checks — 심사·감리 지적사례·감독지침·모범사례 등 게시판 11종.
- Filters alone (no query) sweep a topic.`,
  usage: `1. "전환사채 콜옵션 관련 감독원 자료" → query="전환사채 콜옵션"
2. "작년 감리 지적사례 전부" → board="sanction_case", date_from="2025-01-01", date_to="2025-12-31"
3. "내부회계관리제도 주제로 20건" → topics=["내부회계관리제도"], limit=20`,
  response: `- { total, showing, offset, note, results:[{ntt_id, date, board, source, title, nature, topics,
  depts, summary, url, snippet?}] }
- total = 전체 건수, showing = 이번 페이지 — paginate with offset.
- source: "fss"=금융감독원, "fsc"=금융위원회.
- snippet marks matches with [ … ]; only when a query matched.`,
  rules: `- board is asymmetric: param = English key, response = 한글 라벨 — never feed it back.
- topics·depts are joined strings (", " / " / "), not arrays — split first.
- All tokens must appear (substring); 제목 hits rank first. No query → 게시일 DESC, no snippet.
- Corpus = 2010 onward (absent = 미수록); quote body via get_document, not summary·snippet.`,
  input: {
    query: z.string().optional().describe("검색 키워드 (공백 구분, 예: '전환사채 콜옵션')"),
    topics: z.array(z.string()).optional().describe("주제 태그 필터 (하나라도 일치, list_tags의 topics 값)"),
    nature: z.enum(["감리·조사결과", "제도개정", "지침·모범사례", "실태·통계", "행사·안내", "기타"])
      .optional().describe("문서 성격 필터"),
    board: z.enum(BOARD_PARAM_VALUES).optional().describe("게시판 필터"),
    source: z.enum(["fss", "fsc"]).optional().describe("발행기관 필터 (fss=금융감독원, fsc=금융위원회)"),
    dept: z.string().optional().describe("담당부서명 부분일치 (예: '회계감리')"),
    date_from: z.string().optional().describe("YYYY-MM-DD 이후"),
    date_to: z.string().optional().describe("YYYY-MM-DD 이전"),
    limit: z.number().optional().default(15).describe("최대 결과 수 (기본 15)"),
    offset: z.number().optional().default(0).describe("페이지네이션 오프셋"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ query, topics, nature, board, source, dept, date_from, date_to, limit, offset }, { corpus }) => {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (nature) { conds.push(`d.nature = ?`); params.push(nature); }
    if (board) { conds.push(`d.board = ?`); params.push(BOARD_KEY[board]); }
    if (source) { conds.push(`d.source = ?`); params.push(source); }
    if (date_from) { conds.push(`d.published_at >= ?`); params.push(date_from); }
    if (date_to) { conds.push(`d.published_at <= ?`); params.push(date_to); }
    if (dept) {
      conds.push(`EXISTS (SELECT 1 FROM document_departments dd JOIN departments dep ON dep.dept_id = dd.dept_id
                  WHERE dd.ntt_id = d.ntt_id AND dep.name LIKE ?)`);
      params.push(`%${dept}%`);
    }
    if (topics?.length) {
      conds.push(`EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.tag_id = dt.tag_id
                  WHERE dt.ntt_id = d.ntt_id AND t.name IN (${topics.map(() => "?").join(",")}))`);
      params.push(...topics);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const ROW = `SELECT d.ntt_id, d.published_at, d.title, d.nature, d.summary, d.board, d.source, d.source_url FROM documents d`;

    if (!query?.trim()) {
      const rows = corpus.prepare(`${ROW} ${where} ORDER BY d.published_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as DocRow[];
      const { n } = corpus.prepare(`SELECT COUNT(*) n FROM documents d ${where}`).get(...params) as { n: number };
      return asText({ total: n, showing: rows.length, offset, note: NOTE, results: rows.map((r) => decorate(corpus, r)) });
    }

    const ix = docIndex(corpus);
    const q = queryTerms(query);
    const allowed = conds.length
      ? new Set(corpus.prepare(`SELECT d.ntt_id FROM documents d ${where}`).pluck().all(...params) as number[])
      : undefined;
    const stats = rankStats(corpus, ix, q);
    const ranked = rankDocs(findDocs(corpus, ix, splitQuery(query).match, q, allowed), q, stats, offset + limit, relevance);

    const rowStmt = corpus.prepare(`${ROW} WHERE d.ntt_id = ?`);
    const textStmt = corpus.prepare(`SELECT title, summary, body FROM docs_fts WHERE rowid = ?`);
    const results = ranked.slice(offset, offset + limit).map((d) => {
      const row = rowStmt.get(d.ntt_id) as DocRow;
      const t = textStmt.get(d.rowid) as { title: string | null; summary: string | null; body: string | null } | undefined;
      const snippet = makeSnippet(t?.body ?? "", q, stats) ?? makeSnippet(t?.summary ?? "", q, stats)
        ?? makeSnippet(t?.title ?? "", q, stats);
      return decorate(corpus, snippet ? { ...row, snippet } : row);
    });
    return asText({ total: ranked.length, showing: results.length, offset, note: NOTE, results });
  },
});
