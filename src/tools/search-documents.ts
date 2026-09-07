import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { splitQuery } from "../search/query.js";
import { BOARD_KEY, BOARD_PARAM_VALUES, decorate, type DocRow } from "./doc-shared.js";

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
- ≥3-char tokens → FTS (AND, rank); 1~2-char → LIKE. No query → 게시일 DESC, no snippet.
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
    let match = "";
    let short: string[] = [];

    if (query?.trim()) {
      ({ match, short } = splitQuery(query));
      if (match) {
        conds.push(`docs_fts MATCH ?`);
        params.push(match);
      }
      for (const t of short) {
        conds.push(`(f.title LIKE ? OR f.summary LIKE ? OR f.body LIKE ?)`);
        const like = `%${t}%`;
        params.push(like, like, like);
      }
    }
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

    const useFts = Boolean(query?.trim());
    const from = useFts
      ? `FROM docs_fts f JOIN documents d ON d.ntt_id = f.ntt_id`
      : `FROM documents d`;
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const order = match ? `ORDER BY rank` : `ORDER BY d.published_at DESC`;
    const snippetCol = match ? `, snippet(docs_fts, 2, '[', ']', '…', 16) AS snippet` : "";

    const rows = corpus.prepare(`
      SELECT d.ntt_id, d.published_at, d.title, d.nature, d.summary, d.board, d.source, d.source_url ${snippetCol}
      ${from} ${where} ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset) as DocRow[];
    const { n } = corpus.prepare(`SELECT COUNT(*) n ${from} ${where}`).get(...params) as { n: number };

    return asText({
      total: n,
      showing: rows.length,
      offset,
      note: "수록 문서는 2010년 이후 회계·공시 자료 (2010년 이전 구문서는 미수록)",
      results: rows.map((r) => decorate(corpus, r)),
    });
  },
});
