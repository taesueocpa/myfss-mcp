/**
 * /mcp 인증 판정 — 관리자 토큰(timingSafeEqual) + 자격 요구 범위·거부 코드.
 * 발급 토큰의 원격 검증은 token-gate.ts(eocpa.kr/validate, fail-closed).
 *
 * 불변식:
 *  - 관리자 토큰 미설정(빈 값)은 어떤 토큰과도 일치하지 않는다 — 설정 누락은 권한 사유가 아니다.
 *  - 토큰 추출은 ?key= 우선, 그다음 커스텀 헤더(x-eocpa-token → x-api-key), 마지막 Authorization: Bearer.
 */
import { timingSafeEqual } from "node:crypto";

export interface TokenHeaders {
  authorization?: string;
  "x-eocpa-token"?: string;
  "x-api-key"?: string;
}

/**
 * 요청에서 접속 토큰 추출. 커스텀 헤더는 PlayMCP 처럼 Authorization 을 OAuth 전용으로 다루는
 * 게이트웨이용이다 — 같은 토큰을 어느 슬롯에 실어도 판정은 같다.
 */
export function extractToken(queryKey: unknown, headers: TokenHeaders = {}): string | undefined {
  const raw =
    (typeof queryKey === "string" ? queryKey : undefined) ??
    headers["x-eocpa-token"] ??
    headers["x-api-key"] ??
    headers.authorization?.replace(/^Bearer\s+/i, "");
  return raw?.trim() || undefined;
}

/** 관리자 토큰 일치 여부(타이밍 비의존). 미설정·빈 토큰이면 항상 false. */
export function isAdminToken(provided: string | undefined, adminToken: string | undefined): boolean {
  if (!adminToken || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 이 요청이 자격을 요구하는가 — `tools/call` 만 요구한다.
 *
 * `initialize`·`notifications/*`·`tools/list`·`ping` 은 프로토콜 핸드셰이크·디스커버리라 코퍼스를
 * 한 글자도 내주지 않는다. 그리고 커넥터(claude.ai 등)는 등록할 때 무자격으로 서버를 한 번
 * 찔러 보는데, 거기서 401 을 받으면 MCP 인가 스펙상 "인가 플로우를 개시하라"는 신호로 읽어
 * 「로그인 필요」를 붙인다. 배치 요청은 하나라도 `tools/call` 이면 자격을 요구한다.
 */
export function requiresCredential(body: unknown): boolean {
  const items = Array.isArray(body) ? body : [body];
  return items.some((b) => (b as { method?: unknown } | null | undefined)?.method === "tools/call");
}

/**
 * 거부 응답의 상태코드 — 제시됐으나 거부된 자격은 401 이 아니라 403 이다.
 *
 * 401 은 MCP 인가 스펙이 인가 플로우 개시에 예약해 둔 코드라, SDK 클라이언트는 401 을 받으면 본문을
 * 버리고 OAuth 로 간다 — 원인("이 토큰은 유효하지 않다")이 이용자에게 닿지 않는다. 자격 **미제시**만
 * 401 로 남긴다.
 */
export function deniedStatus(token: string | undefined): 401 | 403 {
  return token ? 403 : 401;
}

/**
 * [MCP 스펙 MUST] /mcp Origin 헤더 검증 — DNS rebinding 방어(Streamable HTTP §Security).
 * 비브라우저 MCP 클라이언트(claude.ai 커넥터·Claude Code·Inspector CLI·PlayMCP 게이트웨이)는 Origin 을
 * 보내지 않으므로 **부재는 통과**가 스펙 정합이고, 이 함수는 '존재하는' Origin 만 판정한다.
 * rebinding 의 실질 표적은 로컬 HTTP 인스턴스라 localhost 계열(포트 무관)은 상시 허용, 원격 웹 기반
 * 클라이언트는 MCP_ALLOWED_ORIGINS(콤마 구분)로 명시 등재한다. 'null'·유사 도메인(localhost.evil.com)은 거부.
 */
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export function isAllowedMcpOrigin(origin: string, extraAllowed: readonly string[] = []): boolean {
  const norm = origin.trim().replace(/\/+$/, "").toLowerCase();
  if (LOCAL_ORIGIN_RE.test(norm)) return true;
  return extraAllowed.some((o) => o.trim().replace(/\/+$/, "").toLowerCase() === norm);
}

/** MCP_ALLOWED_ORIGINS 판독 — 콤마 구분, 공백·빈 항목 무시. */
export function allowedOriginsFromEnv(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
