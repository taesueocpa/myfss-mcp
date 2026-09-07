/**
 * 검색어 분해 — trigram FTS5 하이브리드의 순수 함수부.
 *
 * trigram 토크나이저는 3글자 미만 질의를 MATCH 할 수 없다. 그래서 3글자 이상 토큰은
 * FTS MATCH(AND 결합, rank 정렬)로, 1~2글자 토큰은 LIKE 보조 필터로 보낸다.
 * search_documents 의 [Rules] 가 이 함수의 동작을 그대로 서술한다 — 여기를 바꾸면
 * description 도 함께 바꿔야 한다.
 */

/** 검색어를 FTS MATCH(3글자 이상)와 LIKE(2글자 이하) 조건으로 분배 */
export function splitQuery(query: string): { match: string; short: string[] } {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const long = tokens.filter((t) => [...t].length >= 3);
  const short = tokens.filter((t) => [...t].length < 3);
  const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
  return { match, short };
}
