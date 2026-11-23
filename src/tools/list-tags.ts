import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { BOARD_KEY, BOARD_LABEL } from "./doc-shared.js";

export const listTags = defineTool({
  name: "list_tags",
  title: "검색 어휘 사전",
  summary: "검색 필터에 넣을 수 있는 어휘를 반환합니다 — 주제 태그·문서 성격·게시판·주요 담당부서.",
  purpose: `- Which values actually exist for search_documents' topics·nature·board·dept.
  Invented values return 0 rows, not an error — check here before a futile search.`,
  usage: `1. "어떤 주제로 검색할 수 있어?" → (인자 없음)`,
  response: `- { topics:[{name, n}], natures:[{name, n}], boards:[{key, label, n}], depts_top25:[{name, n}] }
- n = 그 값이 붙은 문서 수.
- boards[].key is what the board parameter takes; boards[].label is what responses show.`,
  rules: `- topics is exact-match — no partial/synonym matching; pass a name from here verbatim.
- dept is the opposite, partial match — a fragment like "회계감리" works.
- depts_top25 is only the top 25 — a 부서 missing from the list still exists.`,
  input: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async (_args, { corpus }) => {
    const topics = corpus.prepare(`
      SELECT t.name, COUNT(*) n FROM document_tags dt JOIN tags t ON t.tag_id = dt.tag_id
      GROUP BY t.name ORDER BY n DESC`).all();
    const natures = corpus.prepare(`
      SELECT nature AS name, COUNT(*) n FROM documents WHERE nature IS NOT NULL
      GROUP BY nature ORDER BY n DESC`).all();
    const boards = corpus.prepare(`
      SELECT board, COUNT(*) n FROM documents GROUP BY board`).all() as { board: string; n: number }[];
    const depts = corpus.prepare(`
      SELECT dep.name, COUNT(*) n FROM document_departments dd
      JOIN departments dep ON dep.dept_id = dd.dept_id
      GROUP BY dep.name ORDER BY n DESC LIMIT 25`).all();
    return asText({
      topics, natures,
      boards: boards.map((b) => ({
        key: Object.entries(BOARD_KEY).find(([, v]) => v === b.board)?.[0] ?? b.board,
        label: BOARD_LABEL[b.board] ?? b.board,
        n: b.n,
      })),
      depts_top25: depts,
    });
  },
});
