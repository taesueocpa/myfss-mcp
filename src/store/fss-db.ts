/**
 * fss.sqlite — read-only 코퍼스(usage.sqlite 와 분리).
 *
 *  - openDb(): 쓰기 모드 + 스키마 보장 + 멱등 마이그레이션(코퍼스를 직접 구축할 때).
 *  - openCorpus(): 서버용. read-only + 검증(파일 존재·docs_fts 인덱스) — 실패하면 CorpusError.
 *    stdio 는 부팅을 중단하고, HTTP 는 코퍼스 없이도 떠서 /mcp 만 503 을 낸다.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CorpusError } from "../core/errors.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(ROOT, "data");
/** Fly 등 배포 환경에서는 FSS_DB_PATH(예: /app/data/fss.sqlite)로 재지정 */
export const DB_PATH = process.env.FSS_DB_PATH ?? join(DATA_DIR, "fss.sqlite");

/** 코퍼스 기준일 — 2010년 이후만 수집·보존. 본문(다운로드·파싱)뿐 아니라 메타데이터(documents)도
 *  이 기준일 이후만 둔다. crawl-list 도 이 값으로 하한을 걸어 구문서 재유입을 막는다. */
export const CORPUS_FROM = "2010-01-01";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  ntt_id         INTEGER PRIMARY KEY,          -- FSS 게시물 ID
  title          TEXT NOT NULL,
  published_at   TEXT NOT NULL,                -- YYYY-MM-DD
  source_url     TEXT NOT NULL,
  markdown       TEXT,                         -- 2단계: kordoc 파싱 결과
  parser_version TEXT,
  crawled_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS departments (
  dept_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name    TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS document_departments (
  ntt_id  INTEGER NOT NULL REFERENCES documents(ntt_id),
  dept_id INTEGER NOT NULL REFERENCES departments(dept_id),
  PRIMARY KEY (ntt_id, dept_id)
);

CREATE TABLE IF NOT EXISTS attachments (
  atch_file_id TEXT NOT NULL,
  file_sn      INTEGER NOT NULL,
  ntt_id       INTEGER NOT NULL REFERENCES documents(ntt_id),
  file_name    TEXT NOT NULL,
  ext          TEXT,
  local_path   TEXT,                           -- 2단계: 다운로드 후 상대경로
  PRIMARY KEY (atch_file_id, file_sn)
);

-- 태그는 파생 데이터: 어휘 개정 시 vocab_version 올려서 재태깅
CREATE TABLE IF NOT EXISTS tags (
  tag_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  vocab_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (name, vocab_version)
);

CREATE TABLE IF NOT EXISTS document_tags (
  ntt_id     INTEGER NOT NULL REFERENCES documents(ntt_id),
  tag_id     INTEGER NOT NULL REFERENCES tags(tag_id),
  confidence REAL,
  tagged_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ntt_id, tag_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_published ON documents(published_at);
CREATE INDEX IF NOT EXISTS idx_attachments_ntt ON attachments(ntt_id);
`;

/** 수집용: 쓰기 모드로 열고 스키마·멱등 마이그레이션을 보장한다. */
export function openDb(path: string = DB_PATH): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 기존 DB에 컬럼 추가 (멱등) */
function migrate(db: Database.Database) {
  const cols = (db.prepare(`PRAGMA table_info(attachments)`).all() as { name: string }[])
    .map((c) => c.name);
  if (!cols.includes("markdown")) db.exec(`ALTER TABLE attachments ADD COLUMN markdown TEXT`);
  if (!cols.includes("parse_status")) db.exec(`ALTER TABLE attachments ADD COLUMN parse_status TEXT`);
  if (!cols.includes("parser_version")) db.exec(`ALTER TABLE attachments ADD COLUMN parser_version TEXT`);

  const dcols = (db.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[])
    .map((c) => c.name);
  // 태깅 산출물: 성격(단일)은 컬럼, 주제(복수)는 document_tags, 요약은 MCP 목록용
  if (!dcols.includes("nature")) db.exec(`ALTER TABLE documents ADD COLUMN nature TEXT`);
  if (!dcols.includes("summary")) db.exec(`ALTER TABLE documents ADD COLUMN summary TEXT`);
  // 출처 게시판: B0000188(보도자료)·B0000127(감독지침)·B0000128(주석공시 모범사례)·MANUAL(수동 등록)
  if (!dcols.includes("board"))
    db.exec(`ALTER TABLE documents ADD COLUMN board TEXT NOT NULL DEFAULT 'B0000188'`);
  // 발행 기관: fss(금융감독원) / fsc(금융위원회). 다기관 코퍼스 구분용
  if (!dcols.includes("source"))
    db.exec(`ALTER TABLE documents ADD COLUMN source TEXT NOT NULL DEFAULT 'fss'`);
}

/**
 * 전문검색 인덱스(docs_fts, trigram) 리빌드 — 크롤·파싱·태깅 후 실행 (파생 데이터).
 * 문서 단위로 제목+요약+본문(성공 파싱된 첨부 마크다운 연결)을 인덱싱한다.
 *
 * DDL·컬럼 순서가 유선 계약이다: search_documents 의 snippet(docs_fts, 2, …) 의 숫자 2가
 * 세 번째 컬럼 body 를 가리킨다 — 순서를 바꾸면 스니펫이 조용히 다른 필드를 자른다.
 */
export function rebuildDocsFts(db: Database.Database): number {
  db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
    title, summary, body, ntt_id UNINDEXED, tokenize='trigram'
  );
  DELETE FROM docs_fts;
`);
  const insert = db.prepare(`
  INSERT INTO docs_fts (ntt_id, title, summary, body)
  SELECT d.ntt_id, d.title, COALESCE(d.summary, ''),
         COALESCE((SELECT GROUP_CONCAT(a.markdown, char(10) || char(10))
                   FROM attachments a
                   WHERE a.ntt_id = d.ntt_id AND a.parse_status = 'ok'), d.markdown, '')
  FROM documents d`);
  const { changes } = insert.run();
  db.exec(`INSERT INTO docs_fts(docs_fts) VALUES('optimize')`);
  return changes;
}

/**
 * 서버용: read-only 로 열고 서빙 가능 상태를 검증한다.
 * 실패는 CorpusError — message 가 곧 복구 안내다.
 */
export function openCorpus(path: string = DB_PATH): Database.Database {
  if (!existsSync(path))
    throw new CorpusError(`fss.sqlite 없음: ${path} (FSS_DB_PATH 로 경로 지정)`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const fts = db
    .prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name = 'docs_fts'`)
    .get() as { n: number };
  if (fts.n < 1) {
    db.close();
    throw new CorpusError("FTS 인덱스 없음 — rebuildDocsFts() 로 인덱스를 먼저 만들 것");
  }
  return db;
}
