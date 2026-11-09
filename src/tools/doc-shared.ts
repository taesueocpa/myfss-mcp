import type Database from "better-sqlite3";

export const BOARD_LABEL: Record<string, string> = {
  B0000188: "보도자료",
  B0000127: "감독지침",
  B0000128: "주석공시 모범사례",
  B0000154: "회계감독 동향자료",
  B0000140: "외부감사 업무자료",
  B0000155: "내부회계관리제도",
  B0000152: "교육자료",
  B0000135: "심사·감리 지적사례",
  ACCNUT02: "회계감리결과제재",
  no010101: "금융위 보도자료",
  MANUAL: "수동등록",
};
export const BOARD_KEY: Record<string, string> = {
  press: "B0000188",
  guidance: "B0000127",
  modelnotes: "B0000128",
  trend: "B0000154",
  extaudit: "B0000140",
  icfr: "B0000155",
  education: "B0000152",
  sanction_case: "B0000135",
  sanction_corp: "ACCNUT02",
  fsc_press: "no010101",
  manual: "MANUAL",
};

// board 파라미터는 영문 키를 받고 응답은 한글 라벨을 낸다(의도한 비대칭)
export const BOARD_PARAM_VALUES = [
  "press", "guidance", "modelnotes", "manual", "trend", "extaudit", "icfr",
  "education", "sanction_case", "sanction_corp", "fsc_press",
] as const;

export interface DocRow {
  ntt_id: number;
  published_at: string;
  title: string;
  nature: string | null;
  summary: string | null;
  board: string;
  source: string;
  source_url: string;
  snippet?: string;
}

export function decorate(db: Database.Database, r: DocRow) {
  const topics = db.prepare(`
    SELECT GROUP_CONCAT(t.name, ', ') s FROM document_tags dt
    JOIN tags t ON t.tag_id = dt.tag_id WHERE dt.ntt_id = ?`).get(r.ntt_id) as { s: string | null };
  const depts = db.prepare(`
    SELECT GROUP_CONCAT(dep.name, ' / ') s FROM document_departments dd
    JOIN departments dep ON dep.dept_id = dd.dept_id WHERE dd.ntt_id = ?`).get(r.ntt_id) as { s: string | null };
  return {
    ntt_id: r.ntt_id,
    date: r.published_at,
    board: BOARD_LABEL[r.board] ?? r.board,
    source: r.source,
    title: r.title,
    nature: r.nature,
    topics: topics.s,
    depts: depts.s,
    summary: r.summary,
    url: r.source_url,
    ...(r.snippet ? { snippet: r.snippet } : {}),
  };
}
