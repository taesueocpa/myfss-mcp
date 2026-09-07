import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { BOARD_KEY, BOARD_PARAM_VALUES, decorate, type DocRow } from "./doc-shared.js";

export const listRecent = defineTool({
  name: "list_recent",
  title: "최신 문서 목록",
  summary: "최신 문서 목록을 게시일 내림차순으로 반환합니다.",
  purpose: `- Query-less skim of "what came out lately", optionally narrowed by 게시판.`,
  usage: `1. "최근 자료 뭐 있어" → (인자 없음 — limit=20)
2. "감리 지적사례 최신 10건" → board="sanction_case", limit=10
3. "금융위 보도자료 최신" → board="fsc_press"`,
  response: `- { results:[{ntt_id, date, board, source, title, nature, topics, depts, summary, url}] }
- No total/offset — this tool has no pagination, and no snippet (there is no query).`,
  rules: `- board takes the English key while the response returns the 한글 라벨 — same asymmetry as
  search_documents; never feed the response board back as a parameter.
- Sorted by 게시일(date) — retroactively registered old documents never surface as new.
- For period/topic narrowing or larger volumes use search_documents.`,
  input: {
    limit: z.number().optional().default(20).describe("최대 결과 수 (기본 20)"),
    board: z.enum(BOARD_PARAM_VALUES).optional().describe("게시판 필터"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit, board }, { corpus }) => {
    const where = board ? `WHERE board = '${BOARD_KEY[board]}'` : "";
    const rows = corpus.prepare(`
      SELECT ntt_id, published_at, title, nature, summary, board, source, source_url
      FROM documents ${where} ORDER BY published_at DESC LIMIT ?`).all(limit) as DocRow[];
    return asText({ results: rows.map((r) => decorate(corpus, r)) });
  },
});
