/**
 * 원격 HTTP 모드. stateless: 요청마다 서버+트랜스포트 생성.
 *
 * 라우트:
 *  - POST /mcp         메인 채널 — 무절단
 *  - POST /mcp/playmcp PlayMCP 채널 — 응답 예산 가드 + 채널 기본값 + 운영 도구 미등록
 *                      (playmcp-profile.ts). 두 MCP 경로의 차이는 프로필뿐 — Origin 검증·인증·
 *                      레이트리밋·usage 로깅은 공통.
 *  - GET  /health      공개 헬스체크
 *  - GET  / · /token · POST /signup → eocpa.kr 로 리다이렉트(랜딩·토큰 발급 페이지)
 *
 * /mcp 의 `tools/call` 만 자격을 요구한다(auth.ts) — 관리자 토큰은 로컬 판정, 발급 토큰은
 * eocpa.kr/validate 원격 검증(token-gate.ts).
 * 코퍼스(fss.sqlite)가 없어도 부팅한다 — /mcp 만 503 을 낸다.
 *
 * env:
 *  - PORT (기본 8080), FSS_DB_PATH (기본 data/fss.sqlite)
 *  - MCP_TOKEN (관리자 토큰), TOKEN_VALIDATE_URL (기본 https://eocpa.kr/validate)
 *  - CORS_ORIGIN (기본 *), RATE_LIMIT_RPM (기본 300, IP당)
 *  - PLAYMCP_LIMIT · PLAYMCP_LIMIT_UNIT (playmcp-budget.ts — 기본 24000 chars)
 *  - MCP_ALLOWED_ORIGINS (/mcp Origin 허용목록, 콤마 구분 — 부재 Origin 은 항상 통과)
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type Database from "better-sqlite3";
import { openCorpus } from "../store/fss-db.js";
import { UsageDb, hashToken } from "../store/usage-db.js";
import { buildServer } from "./build-server.js";
import { extractToken, requiresCredential, deniedStatus, isAllowedMcpOrigin, allowedOriginsFromEnv } from "./auth.js";
import { TokenGate } from "./token-gate.js";
import { createRateLimiter, type RateLimiter } from "./ratelimit.js";
import type { McpProfile } from "./playmcp-profile.js";
import { SERVER_NAME, VERSION } from "../version.js";
import { CorpusError } from "../core/errors.js";

const HUB_LANDING_URL = "https://eocpa.kr/myfss";
const HUB_TOKEN_URL = "https://eocpa.kr/token";
const HUB_SIGNUP_URL = "https://eocpa.kr/signup";

export interface AppDeps {
  /** 코퍼스 핸들 — 지연 개방이라 null 이면 /mcp 503. */
  getDb: () => Database.Database | null;
  usage: UsageDb;
  gate: TokenGate;
  corsOrigin?: string;
  rateLimitRpm?: number;
  limiter?: RateLimiter;
  /** /mcp Origin 허용목록(MCP_ALLOWED_ORIGINS) — localhost 계열은 목록과 무관하게 항상 허용. */
  allowedOrigins?: readonly string[];
}

/** Express 앱 조립. */
export function createApp(deps: AppDeps): express.Express {
  const { getDb, usage, gate, allowedOrigins = [] } = deps;
  const CORS_ORIGIN = deps.corsOrigin ?? "*";
  const RATE_LIMIT_RPM = deps.rateLimitRpm ?? 300;
  const limiter = deps.limiter ?? createRateLimiter();
  const rateLimited = (key: string, limit: number = RATE_LIMIT_RPM) => limiter.limited(key, limit);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", CORS_ORIGIN);
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-eocpa-token, x-api-key, mcp-session-id, mcp-protocol-version, last-event-id",
    );
    res.header("Access-Control-Expose-Headers", "mcp-session-id");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // [MCP 스펙 MUST] /mcp·/mcp/playmcp Origin 검증 — 부재는 통과, 존재하는데 허용목록 밖이면 403(auth.ts).
  app.use("/mcp", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined || isAllowedMcpOrigin(origin, allowedOrigins)) return next();
    res.status(403).json({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message:
          `Forbidden: Origin '${String(origin).slice(0, 200)}' is not allowed on this MCP endpoint. ` +
          `브라우저 기반 클라이언트라면 서버 환경변수 MCP_ALLOWED_ORIGINS 에 이 origin 을 추가하세요.`,
      },
      id: null,
    });
  });

  // ── 웹 표면 리다이렉트 (랜딩·토큰 발급은 eocpa.kr) ──────────────

  app.get("/", (req, res) => {
    const host = req.hostname ?? "";
    if (host.startsWith("myfss.")) return res.redirect(301, HUB_LANDING_URL);
    return res.redirect(302, HUB_TOKEN_URL);
  });

  app.get("/token", (_req, res) => {
    res.redirect(301, HUB_TOKEN_URL);
  });

  // 308 = 메서드·본문 보존 — 구 폼에서 제출해도 새 창구로 그대로 재전송된다.
  app.post("/signup", (_req, res) => {
    res.redirect(308, HUB_SIGNUP_URL);
  });

  // ── 헬스체크 ──────────────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    const d = getDb();
    let docs: number | null = null;
    if (d) {
      try {
        docs = (d.prepare(`SELECT COUNT(*) n FROM documents`).get() as { n: number }).n;
      } catch { /* 일시 오류 무시 */ }
    }
    res.json({ status: "ok", db: d ? "ready" : "missing", docs, name: SERVER_NAME, version: VERSION });
  });

  // ── MCP ───────────────────────────────────────────────────────────

  const mcpHandler = (profile: McpProfile) => async (req: express.Request, res: express.Response) => {
    const ip = req.ip ?? "unknown";
    if (rateLimited(ip)) {
      return res.status(429).json({
        jsonrpc: "2.0", error: { code: -32000, message: "rate limit exceeded" }, id: null,
      });
    }
    const provided = extractToken(req.query.key, req.headers);
    // 자격 요구 범위와 거부 코드는 auth.ts 가 판정한다:
    //   ① tools/call 만 자격을 요구한다 — 핸드셰이크·디스커버리(initialize·tools/list·ping)는 무자격 통과.
    //   ② 제시됐으나 거부된 자격은 403, 미제시만 401.
    if (requiresCredential(req.body) && !(await gate.authorize(provided))) {
      return res.status(deniedStatus(provided)).json({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: provided
            ? "이 토큰은 유효하지 않습니다 — 회전·중지됐거나 검증 서버에 닿지 못했습니다. 재발급·확인: https://eocpa.kr/token"
            : "unauthorized — https://eocpa.kr/token 에서 토큰을 발급받으세요",
        },
        id: (Array.isArray(req.body) ? req.body[0]?.id : req.body?.id) ?? null,
      });
    }
    // 도구 사용량 로깅용 세션 — 이용자=토큰 해시(원문 미저장), 운영자=관리자 토큰 일치.
    const session = {
      userHash: hashToken(provided),
      isOwner: gate.isAdmin(provided),
      transport: "http" as const,
      client: req.headers["user-agent"] as string | undefined,
    };

    const d = getDb();
    if (!d) {
      return res.status(503).json({
        jsonrpc: "2.0", error: { code: -32002, message: "DB 준비 안 됨" }, id: null,
      });
    }
    try {
      const server = buildServer({ corpus: d, usage, session }, { profile });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP 요청 처리 오류:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null,
        });
      }
    }
  };

  app.post("/mcp", mcpHandler("full"));
  app.post("/mcp/playmcp", mcpHandler("playmcp"));

  // stateless 모드: 세션 스트림/종료 미지원
  const noSession = (_req: express.Request, res: express.Response) => {
    res.status(405).json({
      jsonrpc: "2.0", error: { code: -32000, message: "stateless server — POST only" }, id: null,
    });
  };
  for (const path of ["/mcp", "/mcp/playmcp"]) {
    app.get(path, noSession);
    app.delete(path, noSession);
  }
  return app;
}

export async function serveHttp(): Promise<void> {
  const PORT = Number(process.env.PORT ?? 8080);
  const ADMIN_TOKEN = process.env.MCP_TOKEN;
  const validateUrl = process.env.TOKEN_VALIDATE_URL ?? "https://eocpa.kr/validate";
  // 발급 토큰 원격 검증 — fail-closed, 유효 5분·무효 1분 캐시.
  const gate = new TokenGate({ adminToken: ADMIN_TOKEN, validateUrl, svc: "fss" });

  // 코퍼스는 지연 개방 — 없거나 FTS 미구축이면 null 로 접고 /mcp 만 503. 같은 사유는 1회만 로그.
  let db: Database.Database | null = null;
  let lastCorpusError = "";
  const getDb = (): Database.Database | null => {
    if (db) return db;
    try {
      db = openCorpus();
      console.error(`DB 연결: 코퍼스 준비됨`);
      return db;
    } catch (err) {
      const msg = err instanceof CorpusError ? err.message : String(err);
      if (msg !== lastCorpusError) {
        console.error(`코퍼스 미가용: ${msg}`);
        lastCorpusError = msg;
      }
      return null;
    }
  };

  const app = createApp({
    getDb,
    usage: new UsageDb(),
    gate,
    corsOrigin: process.env.CORS_ORIGIN,
    rateLimitRpm: Number(process.env.RATE_LIMIT_RPM ?? 300),
    allowedOrigins: allowedOriginsFromEnv(process.env.MCP_ALLOWED_ORIGINS),
  });

  app.listen(PORT, () => {
    console.error(
      `myfss MCP HTTP 서버 v${VERSION}: :${PORT}/mcp · /mcp/playmcp (DB ${getDb() ? "ready" : "missing"}, ` +
      `토큰 검증 ${validateUrl})`,
    );
  });
}
