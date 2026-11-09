// trigram 토크나이저는 3글자 미만을 MATCH 하지 못해 짧은 토큰은 LIKE 로 거른다
export function splitQuery(query: string): { match: string; short: string[] } {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const long = tokens.filter((t) => [...t].length >= 3);
  const short = tokens.filter((t) => [...t].length < 3);
  const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
  return { match, short };
}
