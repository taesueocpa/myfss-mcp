export function splitQuery(query: string): { match: string; short: string[] } {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const long = tokens.filter((t) => [...t].length >= 3);
  const short = tokens.filter((t) => [...t].length < 3);
  const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
  return { match, short };
}
