import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CorpusError } from "../core/errors.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DATA_DIR = join(ROOT, "data");
export const DB_PATH = process.env.FSS_DB_PATH ?? join(DATA_DIR, "fss.sqlite");

export const CORPUS_FROM = "2010-01-01";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  ntt_id         INTEGER PRIMARY KEY,
  title          TEXT NOT NULL,
  published_at   TEXT NOT NULL,
  source_url     TEXT NOT NULL,
  markdown       TEXT,
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
  local_path   TEXT,
  PRIMARY KEY (atch_file_id, file_sn)
);

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

export function openDb(path: string = DB_PATH): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function migrate(db: Database.Database) {
  const cols = (db.prepare(`PRAGMA table_info(attachments)`).all() as { name: string }[])
    .map((c) => c.name);
  if (!cols.includes("markdown")) db.exec(`ALTER TABLE attachments ADD COLUMN markdown TEXT`);
  if (!cols.includes("parse_status")) db.exec(`ALTER TABLE attachments ADD COLUMN parse_status TEXT`);
  if (!cols.includes("parser_version")) db.exec(`ALTER TABLE attachments ADD COLUMN parser_version TEXT`);

  const dcols = (db.prepare(`PRAGMA table_info(documents)`).all() as { name: string }[])
    .map((c) => c.name);
  if (!dcols.includes("nature")) db.exec(`ALTER TABLE documents ADD COLUMN nature TEXT`);
  if (!dcols.includes("summary")) db.exec(`ALTER TABLE documents ADD COLUMN summary TEXT`);
  if (!dcols.includes("board"))
    db.exec(`ALTER TABLE documents ADD COLUMN board TEXT NOT NULL DEFAULT 'B0000188'`);
  if (!dcols.includes("source"))
    db.exec(`ALTER TABLE documents ADD COLUMN source TEXT NOT NULL DEFAULT 'fss'`);
}

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
