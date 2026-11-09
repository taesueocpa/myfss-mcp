import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const USAGE_DB_PATH = process.env.USAGE_DB_PATH ?? join(ROOT, "data", "usage.sqlite");

export function hashToken(token: string | undefined | null): string | null {
  if (!token) return null;
  return createHash("sha256").update(token).digest("hex");
}

export interface Session {
  userHash: string | null;
  isOwner: boolean;
  transport: "http" | "stdio";
  client?: string | null;
}

export interface UsageEvent {
  tool: string;
  transport: string;
  status: "ok" | "error";
  durationMs: number;
  userHash?: string | null;
  isOwner?: boolean;
  target?: string | null;
  errCode?: string | null;
  client?: string | null;
}

export interface McpRequestEvent {
  method?: string | null;
  tool?: string | null;
  status: number;
  token?: string | null;
  isOwner?: boolean;
  ip?: string | null;
  ua?: string | null;
  durationMs: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tool_calls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  day         TEXT NOT NULL,
  user_hash   TEXT,
  is_owner    INTEGER NOT NULL DEFAULT 0,
  tool        TEXT NOT NULL,
  transport   TEXT NOT NULL,
  status      TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  target      TEXT,
  err_code    TEXT,
  client      TEXT
);
CREATE INDEX IF NOT EXISTS idx_tc_day  ON tool_calls(day);
CREATE INDEX IF NOT EXISTS idx_tc_tool ON tool_calls(tool);
CREATE INDEX IF NOT EXISTS idx_tc_user ON tool_calls(user_hash);
CREATE INDEX IF NOT EXISTS idx_tc_ts   ON tool_calls(ts);
-- /mcp 요청 로그 — initialize·tools/list·notifications·tools/call·거부(401·403)·405·500 전량을 1행씩.
-- user_hash 는 tool_calls 와 같은 SHA-256(토큰), ip_hash 는 SHA-256(IP) 앞 16 hex.
-- auth = token(토큰 제시) / none(미제시). is_owner = 관리자 토큰.
CREATE TABLE IF NOT EXISTS mcp_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  day         TEXT NOT NULL,
  method      TEXT,
  tool        TEXT,
  status      INTEGER,
  user_hash   TEXT,
  is_owner    INTEGER NOT NULL DEFAULT 0,
  auth        TEXT,
  ip_hash     TEXT,
  ua          TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mr_ts   ON mcp_requests(ts);
CREATE INDEX IF NOT EXISTS idx_mr_user ON mcp_requests(user_hash);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- 하루 호출 기준 원장 — day = KST 날짜, user_hash = tool_calls 와 같은 SHA-256(토큰), calls = 실행된 도구 호출 수.
CREATE TABLE IF NOT EXISTS daily_calls (
  day       TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  calls     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_hash)
);
`;

const DEFAULT_RETENTION_DAYS = 365;
const PRUNE_EVERY = 500;
// 자격 없이 열린 요청이 몰려도 디스크 쓰기가 늘지 않게 IP당 분당 기록 수를 묶는다
export const MCP_LOG_PER_IP_PER_MIN = 360;
const MCP_IP_WINDOW_CAP = 10_000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class UsageDb {
  private readonly dbPath: string;
  private readonly retentionDays: number;
  private db: Database.Database | null = null;
  private insertStmt: Database.Statement | null = null;
  private mcpStmt: Database.Statement | null = null;
  private callsAddStmt: Database.Statement | null = null;
  private callsPrunedDay = "";
  private readonly mcpIpWindow = new Map<string, { start: number; n: number }>();
  private sinceLastPrune = 0;

  constructor(opts: { dbPath?: string; retentionDays?: number } = {}) {
    this.dbPath = opts.dbPath ?? USAGE_DB_PATH;
    const env = Number(process.env.USAGE_RETENTION_DAYS);
    this.retentionDays =
      opts.retentionDays ?? (Number.isFinite(env) && env >= 0 ? env : DEFAULT_RETENTION_DAYS);
  }

  private get(): Database.Database {
    if (this.db) return this.db;
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(SCHEMA_SQL);
    this.db = db;
    this.prune();
    return db;
  }

  record(ev: UsageEvent): void {
    try {
      const db = this.get();
      if (!this.insertStmt) {
        this.insertStmt = db.prepare(
          `INSERT INTO tool_calls(ts, day, user_hash, is_owner, tool, transport, status, duration_ms, target, err_code, client)
           VALUES(@ts, @day, @user_hash, @is_owner, @tool, @transport, @status, @duration_ms, @target, @err_code, @client)`,
        );
      }
      const ts = Date.now();
      this.insertStmt.run({
        ts,
        day: isoDay(ts),
        user_hash: ev.userHash ?? null,
        is_owner: ev.isOwner ? 1 : 0,
        tool: ev.tool,
        transport: ev.transport,
        status: ev.status,
        duration_ms: Math.round(ev.durationMs),
        target: ev.target ? ev.target.slice(0, 300) : null,
        err_code: ev.errCode ?? null,
        client: ev.client ? ev.client.slice(0, 200) : null,
      });
      if (++this.sinceLastPrune >= PRUNE_EVERY) this.prune();
    } catch (e) {
      console.error("[usage] record 실패:", e instanceof Error ? e.message : e);
    }
  }

  recordMcpRequest(ev: McpRequestEvent): void {
    try {
      const ts = Date.now();
      const ipHash = ev.ip ? createHash("sha256").update(ev.ip).digest("hex").slice(0, 16) : null;
      if (!this.mcpLogAllowed(ipHash ?? "", ts)) return;
      const db = this.get();
      if (!this.mcpStmt) {
        this.mcpStmt = db.prepare(
          `INSERT INTO mcp_requests(ts, day, method, tool, status, user_hash, is_owner, auth, ip_hash, ua, duration_ms)
           VALUES(@ts, @day, @method, @tool, @status, @user_hash, @is_owner, @auth, @ip_hash, @ua, @duration_ms)`,
        );
      }
      this.mcpStmt.run({
        ts,
        day: isoDay(ts),
        method: ev.method ? ev.method.slice(0, 60) : null,
        tool: ev.tool ? ev.tool.slice(0, 60) : null,
        status: ev.status,
        user_hash: hashToken(ev.token),
        is_owner: ev.isOwner ? 1 : 0,
        auth: ev.token ? "token" : "none",
        ip_hash: ipHash,
        ua: ev.ua ? ev.ua.slice(0, 200) : null,
        duration_ms: Math.round(ev.durationMs),
      });
      if (++this.sinceLastPrune >= PRUNE_EVERY) this.prune();
    } catch (e) {
      console.error("[usage] mcp 요청 기록 실패:", e instanceof Error ? e.message : e);
    }
  }

  callsUsed(day: string, userHash: string): number {
    const r = this.get().prepare("SELECT calls FROM daily_calls WHERE day = ? AND user_hash = ?").get(day, userHash) as
      | { calls: number }
      | undefined;
    return r ? r.calls : 0;
  }

  callsAdd(day: string, userHash: string): void {
    const db = this.get();
    if (!this.callsAddStmt) {
      this.callsAddStmt = db.prepare(
        `INSERT INTO daily_calls(day, user_hash, calls) VALUES(?, ?, 1)
         ON CONFLICT(day, user_hash) DO UPDATE SET calls = calls + 1`,
      );
    }
    this.callsAddStmt.run(day, userHash);
    if (this.callsPrunedDay !== day) {
      this.callsPrunedDay = day;
      const cutoff = new Date(Date.parse(day + "T00:00:00Z") - 7 * 86_400_000).toISOString().slice(0, 10);
      db.prepare("DELETE FROM daily_calls WHERE day < ?").run(cutoff);
    }
  }

  private mcpLogAllowed(key: string, now: number): boolean {
    const w = this.mcpIpWindow.get(key);
    if (!w || now - w.start >= 60_000) {
      if (this.mcpIpWindow.size >= MCP_IP_WINDOW_CAP) this.mcpIpWindow.clear();
      this.mcpIpWindow.set(key, { start: now, n: 1 });
      return true;
    }
    return ++w.n <= MCP_LOG_PER_IP_PER_MIN;
  }

  prune(): void {
    this.sinceLastPrune = 0;
    if (this.retentionDays <= 0) return;
    try {
      const cutoff = Date.now() - this.retentionDays * 86_400_000;
      const db = this.get();
      db.prepare("DELETE FROM tool_calls WHERE ts < ?").run(cutoff);
      db.prepare("DELETE FROM mcp_requests WHERE ts < ?").run(cutoff);
    } catch {
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.insertStmt = null;
    this.mcpStmt = null;
    this.callsAddStmt = null;
  }
}
