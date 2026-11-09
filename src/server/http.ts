import { createMcpHandler, isLegacyRequest } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from "@modelcontextprotocol/node";
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

// Fly 프록시 뒤에서는 Fly-Client-IP 가 실제 클라이언트 IP 다. 레이트리밋과 usage 가 같은 값을 쓴다
export function clientIp(req: express.Request): string {
  return (req.headers["fly-client-ip"] as string | undefined) || req.ip || req.socket.remoteAddress || "unknown";
}

export interface AppDeps {
  getDb: () => Database.Database | null;
  usage: UsageDb;
  gate: TokenGate;
  corsOrigin?: string;
  rateLimitRpm?: number;
  limiter?: RateLimiter;
  allowedOrigins?: readonly string[];
}

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

  const logMcpRequest = (req: express.Request, res: express.Response, token: string | undefined) => {
    const startedAt = Date.now();
    const body = Array.isArray(req.body) ? req.body[0] : req.body;
    const rpc = typeof body?.method === "string" ? (body.method as string) : null;
    const method = req.method === "POST" ? rpc : req.method;
    const tool = rpc === "tools/call" && typeof body?.params?.name === "string" ? (body.params.name as string) : null;
    res.once("finish", () => {
      usage.recordMcpRequest({
        method,
        tool,
        status: res.statusCode,
        token,
        isOwner: gate.isAdmin(token),
        ip: clientIp(req),
        ua: req.headers["user-agent"],
        durationMs: Date.now() - startedAt,
      });
    });
  };

  app.use("/mcp", (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined || isAllowedMcpOrigin(origin, allowedOrigins)) return next();
    logMcpRequest(req, res, extractToken(req.query.key, req.headers));
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

  app.get("/", (req, res) => {
    const host = req.hostname ?? "";
    if (host.startsWith("myfss.")) return res.redirect(301, HUB_LANDING_URL);
    return res.redirect(302, HUB_TOKEN_URL);
  });

  app.get("/token", (_req, res) => {
    res.redirect(301, HUB_TOKEN_URL);
  });

  // 308 은 메서드와 본문을 유지한다
  app.post("/signup", (_req, res) => {
    res.redirect(308, HUB_SIGNUP_URL);
  });

  app.get("/health", (_req, res) => {
    const d = getDb();
    let docs: number | null = null;
    if (d) {
      try {
        docs = (d.prepare(`SELECT COUNT(*) n FROM documents`).get() as { n: number }).n;
      } catch { }
    }
    res.json({ status: "ok", db: d ? "ready" : "missing", docs, name: SERVER_NAME, version: VERSION });
  });

  const sessionFromRequest = (request: Request | undefined) => {
    const h = request?.headers;
    // ?key= 가 여럿이면 인증 게이트와 같이 없는 것으로 본다
    const keys = request ? new URL(request.url).searchParams.getAll("key") : [];
    const key = keys.length === 1 ? keys[0] : null;
    const provided = extractToken(key ?? undefined, {
      authorization: h?.get("authorization") ?? undefined,
      "x-eocpa-token": h?.get("x-eocpa-token") ?? undefined,
      "x-api-key": h?.get("x-api-key") ?? undefined,
    });
    return {
      userHash: hashToken(provided),
      isOwner: gate.isAdmin(provided),
      transport: "http" as const,
      client: h?.get("user-agent") ?? undefined,
    };
  };

  const modernMcp: Record<McpProfile, ReturnType<typeof toNodeHandler>> = {
    full: toNodeHandler(
      createMcpHandler(
        (mcpCtx) => buildServer(
          { corpus: getDb()!, usage, session: sessionFromRequest(mcpCtx.requestInfo) },
          { profile: "full" },
        ),
        { legacy: "reject", responseMode: "json" },
      ),
    ),
    playmcp: toNodeHandler(
      createMcpHandler(
        (mcpCtx) => buildServer(
          { corpus: getDb()!, usage, session: sessionFromRequest(mcpCtx.requestInfo) },
          { profile: "playmcp" },
        ),
        { legacy: "reject", responseMode: "json" },
      ),
    ),
  };

  const mcpHandler = (profile: McpProfile) => async (req: express.Request, res: express.Response) => {
    const provided = extractToken(req.query.key, req.headers);
    logMcpRequest(req, res, provided); // 레이트리밋보다 앞에 둬야 429 도 기록된다
    if (rateLimited(clientIp(req))) {
      return res.status(429).json({
        jsonrpc: "2.0", error: { code: -32000, message: "rate limit exceeded" }, id: null,
      });
    }
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
      const legacyEra = await isLegacyRequest(await toWebRequest(req, req.body), req.body);
      if (!legacyEra) {
        await modernMcp[profile](req, res, req.body);
        return;
      }

      const server = buildServer({ corpus: d, usage, session }, { profile });
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
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

  const noSession = (req: express.Request, res: express.Response) => {
    logMcpRequest(req, res, extractToken(req.query.key, req.headers));
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
  const gate = new TokenGate({ adminToken: ADMIN_TOKEN, validateUrl, svc: "fss" });

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
      `토큰 검증 ${validateUrl}, dual-era: 2025-era + 2026-07-28)`,
    );
  });
}
