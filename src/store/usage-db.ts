/**
 * usage.sqlite — 도구 호출 사용량 이벤트 로그. fss.sqlite 와 분리된 별도 파일이다(운영 데이터).
 *
 * 식별자: 이용자 = 접속 토큰. 원문은 저장하지 않고 SHA-256 해시만 둔다.
 * 노출 등급(get_usage_stats): 운영자(is_owner)는 detailed(), 그 외는 aggregate()(이용자별·검색어 비노출).
 * 지연 백분위(p50/p90/p99)를 함께 집계한다. record()·recordMcpRequest()·prune() 은 절대 throw 하지 않는다.
 *
 * 두 표: tool_calls 는 핸들러까지 간 도구 호출, mcp_requests 는 /mcp 요청 전량(핸드셰이크·거부·405 포함).
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** Fly 등 배포 환경에서는 USAGE_DB_PATH(예: /data/usage.sqlite)로 재지정. 로컬 기본은 ./data/usage.sqlite. */
export const USAGE_DB_PATH = process.env.USAGE_DB_PATH ?? join(ROOT, "data", "usage.sqlite");

/** 토큰 → 안정적 익명 식별자(SHA-256 hex). 원문 미저장. */
export function hashToken(token: string | undefined | null): string | null {
  if (!token) return null;
  return createHash("sha256").update(token).digest("hex");
}

/** 요청 1건의 신원·경로 — 요청마다 서버를 새로 만들 때 클로저로 주입한다. */
export interface Session {
  /** SHA-256(토큰). 관리자 토큰이면 그 해시, 로컬 stdio 면 null. */
  userHash: string | null;
  /** 운영자(관리자 토큰 일치 또는 로컬 stdio) 여부 — 상세 통계 노출 게이트. */
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
  /** 원시 조회 대상(검색어·문서번호 등). 포렌식용 — 운영자에게만 노출. */
  target?: string | null;
  errCode?: string | null;
  client?: string | null;
}

/** /mcp HTTP 요청 1건 — 응답이 확정될 때(res finish) 기록한다. */
export interface McpRequestEvent {
  /** JSON-RPC method(POST — 배치면 첫 항목). 본문이 없는 GET·DELETE(405)는 HTTP 메서드. */
  method?: string | null;
  /** tools/call 이면 도구명. */
  tool?: string | null;
  /** HTTP 상태코드. */
  status: number;
  /** 제시한 토큰 원문 — 여기서 해시하고 버린다. 미제시면 "" 또는 null. */
  token?: string | null;
  /** 관리자 토큰(MCP_TOKEN) 일치. */
  isOwner?: boolean;
  /** 클라이언트 IP — 앞 16 hex 해시만 저장한다. */
  ip?: string | null;
  ua?: string | null;
  durationMs: number;
}

export interface StatsOptions {
  days?: number;
}

export interface ToolStat {
  tool: string;
  calls: number;
  errors: number;
  error_rate: number;
  avg_ms: number;
  p99_ms: number;
  users: number;
}

export interface AggregateStats {
  period: { days: number | "all"; since: string | null; until: string | null };
  overview: {
    total_calls: number;
    unique_users: number;
    errors: number;
    error_rate: number;
    p50_ms: number;
    p90_ms: number;
    p99_ms: number;
  };
  by_tool: ToolStat[];
  by_day: Array<{ day: string; calls: number }>;
}

export interface UserStat {
  user: string;
  is_owner: boolean;
  calls: number;
  distinct_tools: number;
  first_seen: string;
  last_seen: string;
  tools: Array<{ tool: string; calls: number; avg_ms: number }>;
}

export interface DetailedStats extends AggregateStats {
  users: UserStat[];
  top_targets: Array<{ target: string; tool: string; calls: number; users: number }>;
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
`;

const DEFAULT_RETENTION_DAYS = 365;
const PRUNE_EVERY = 500;
/**
 * mcp_requests 쓰기 상한 — IP(해시)당 1분에 이만큼만 남기고 나머지는 세지 않는다.
 * initialize·tools/list 는 무자격으로 열려 있어, 상한이 없으면 요청 폭주가 그대로 영속 볼륨 쓰기가 된다.
 * IP당 분당 300 레이트리밋이 있는 배포에서도 한도에 걸린 429 가 몇 줄은 남도록 그보다 조금 크게 잡았다.
 * 정상 이용은 여기에 닿지 않는다.
 */
export const MCP_LOG_PER_IP_PER_MIN = 360;
const MCP_IP_WINDOW_CAP = 10_000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 최근접 순위(nearest-rank) 백분위 — 오름차순 정렬 배열 전제.
 * 빈 배열은 0 (호출 0건인 창의 관례값 — total_calls 0 과 짝이 맞는다).
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[idx];
}

export class UsageDb {
  private readonly dbPath: string;
  private readonly retentionDays: number;
  private db: Database.Database | null = null;
  private insertStmt: Database.Statement | null = null;
  private mcpStmt: Database.Statement | null = null;
  /** ip_hash 별 1분 창 — mcp_requests 쓰기 상한(MCP_LOG_PER_IP_PER_MIN). */
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

  /** 호출 1건 기록. **절대 throw 하지 않는다.** */
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

  /**
   * /mcp 요청 1건 기록. **절대 throw 하지 않는다**(응답 경로에서 호출).
   * IP 당 분당 MCP_LOG_PER_IP_PER_MIN 건을 넘으면 기록하지 않는다.
   */
  recordMcpRequest(ev: McpRequestEvent): void {
    try {
      const ts = Date.now();
      // ip_hash = SHA-256(IP) 앞 16 hex — 같은 계산을 쓰는 서버끼리는 같은 IP 가 같은 값이 된다.
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

  /** IP(해시) 1분 창 카운터 — 창 수가 상한을 넘으면 통째로 비운다(다음 창부터 다시 센다). */
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
      /* ignore */
    }
  }

  private windowStart(days?: number): number {
    if (!days || days <= 0) return 0;
    return Date.now() - days * 86_400_000;
  }

  /** 집계 통계(이용자별·검색어 비노출) — 공개용. */
  aggregate(opts: StatsOptions = {}): AggregateStats {
    const db = this.get();
    const start = this.windowStart(opts.days);

    const overview = db
      .prepare(
        `SELECT COUNT(*) AS total_calls,
                COUNT(DISTINCT user_hash) AS unique_users,
                SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
                MIN(ts) AS since, MAX(ts) AS until
         FROM tool_calls WHERE ts >= ?`,
      )
      .get(start) as {
      total_calls: number;
      unique_users: number;
      errors: number | null;
      since: number | null;
      until: number | null;
    };

    const byTool = db
      .prepare(
        `SELECT tool, COUNT(*) AS calls,
                SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS errors,
                AVG(duration_ms) AS avg_ms,
                COUNT(DISTINCT user_hash) AS users
         FROM tool_calls WHERE ts >= ?
         GROUP BY tool ORDER BY calls DESC`,
      )
      .all(start) as Array<{ tool: string; calls: number; errors: number; avg_ms: number; users: number }>;

    const byDay = db
      .prepare(
        `SELECT day, COUNT(*) AS calls FROM tool_calls WHERE ts >= ?
         GROUP BY day ORDER BY day DESC LIMIT 60`,
      )
      .all(start) as Array<{ day: string; calls: number }>;

    // 백분위: 창 안의 duration 을 한 번에 끌어와 전체·도구별로 계산한다.
    // 트래픽 상한(레이트리밋·개인 서비스)상 창 전체를 메모리에 올려도 안전한 규모다.
    const durations = db
      .prepare(`SELECT tool, duration_ms FROM tool_calls WHERE ts >= ? ORDER BY duration_ms`)
      .all(start) as Array<{ tool: string; duration_ms: number }>;
    const allSorted = durations.map((d) => d.duration_ms);
    const perTool = new Map<string, number[]>();
    for (const d of durations) {
      const list = perTool.get(d.tool) ?? [];
      list.push(d.duration_ms); // ORDER BY 덕에 그룹 내에서도 오름차순 유지
      perTool.set(d.tool, list);
    }

    const total = overview.total_calls || 0;
    const errors = overview.errors || 0;
    return {
      period: {
        days: opts.days && opts.days > 0 ? opts.days : "all",
        since: overview.since ? isoDay(overview.since) : null,
        until: overview.until ? isoDay(overview.until) : null,
      },
      overview: {
        total_calls: total,
        unique_users: overview.unique_users || 0,
        errors,
        error_rate: total ? +(errors / total).toFixed(4) : 0,
        p50_ms: percentile(allSorted, 50),
        p90_ms: percentile(allSorted, 90),
        p99_ms: percentile(allSorted, 99),
      },
      by_tool: byTool.map((t) => ({
        tool: t.tool,
        calls: t.calls,
        errors: t.errors,
        error_rate: t.calls ? +(t.errors / t.calls).toFixed(4) : 0,
        avg_ms: Math.round(t.avg_ms),
        p99_ms: percentile(perTool.get(t.tool) ?? [], 99),
        users: t.users,
      })),
      by_day: byDay,
    };
  }

  /** 상세 통계(이용자별 도구 사용량 + 인기 검색어) — 운영자 전용. */
  detailed(opts: StatsOptions = {}): DetailedStats {
    const db = this.get();
    const start = this.windowStart(opts.days);
    const base = this.aggregate(opts);

    const users = db
      .prepare(
        `SELECT user_hash, MAX(is_owner) AS is_owner,
                COUNT(*) AS calls, COUNT(DISTINCT tool) AS distinct_tools,
                MIN(ts) AS first_seen, MAX(ts) AS last_seen
         FROM tool_calls WHERE ts >= ? AND user_hash IS NOT NULL
         GROUP BY user_hash ORDER BY calls DESC`,
      )
      .all(start) as Array<{
      user_hash: string;
      is_owner: number;
      calls: number;
      distinct_tools: number;
      first_seen: number;
      last_seen: number;
    }>;

    const perUserTool = db
      .prepare(
        `SELECT user_hash, tool, COUNT(*) AS calls, AVG(duration_ms) AS avg_ms
         FROM tool_calls WHERE ts >= ? AND user_hash IS NOT NULL
         GROUP BY user_hash, tool ORDER BY calls DESC`,
      )
      .all(start) as Array<{ user_hash: string; tool: string; calls: number; avg_ms: number }>;

    const toolsByUser = new Map<string, Array<{ tool: string; calls: number; avg_ms: number }>>();
    for (const r of perUserTool) {
      const list = toolsByUser.get(r.user_hash) ?? [];
      list.push({ tool: r.tool, calls: r.calls, avg_ms: Math.round(r.avg_ms) });
      toolsByUser.set(r.user_hash, list);
    }

    const topTargets = db
      .prepare(
        `SELECT target, tool, COUNT(*) AS calls, COUNT(DISTINCT user_hash) AS users
         FROM tool_calls WHERE ts >= ? AND target IS NOT NULL AND target != ''
         GROUP BY target, tool ORDER BY calls DESC LIMIT 40`,
      )
      .all(start) as Array<{ target: string; tool: string; calls: number; users: number }>;

    return {
      ...base,
      users: users.map((u) => ({
        user: u.user_hash.slice(0, 12),
        is_owner: u.is_owner === 1,
        calls: u.calls,
        distinct_tools: u.distinct_tools,
        first_seen: isoDay(u.first_seen),
        last_seen: isoDay(u.last_seen),
        tools: toolsByUser.get(u.user_hash) ?? [],
      })),
      top_targets: topTargets,
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.insertStmt = null;
    this.mcpStmt = null;
  }
}
