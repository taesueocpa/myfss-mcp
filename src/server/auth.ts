import { timingSafeEqual } from "node:crypto";

export interface TokenHeaders {
  authorization?: string;
  "x-eocpa-token"?: string;
  "x-api-key"?: string;
}

export function extractToken(queryKey: unknown, headers: TokenHeaders = {}): string | undefined {
  const raw =
    (typeof queryKey === "string" ? queryKey : undefined) ??
    headers["x-eocpa-token"] ??
    headers["x-api-key"] ??
    headers.authorization?.replace(/^Bearer\s+/i, "");
  return raw?.trim() || undefined;
}

export function isAdminToken(provided: string | undefined, adminToken: string | undefined): boolean {
  if (!adminToken || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

// tools/call 만 자격을 요구한다. 커넥터는 등록할 때 자격 없이 tools/list 를 부른다
export function requiresCredential(body: unknown): boolean {
  const items = Array.isArray(body) ? body : [body];
  return items.some((b) => (b as { method?: unknown } | null | undefined)?.method === "tools/call");
}

// 자격을 냈는데 거부되면 403. 401 은 클라이언트가 OAuth 시작으로 읽는다
export function deniedStatus(token: string | undefined): 401 | 403 {
  return token ? 403 : 401;
}

// DNS rebinding 방어. Origin 이 없는 요청은 통과, localhost 는 항상 허용
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export function isAllowedMcpOrigin(origin: string, extraAllowed: readonly string[] = []): boolean {
  const norm = origin.trim().replace(/\/+$/, "").toLowerCase();
  if (LOCAL_ORIGIN_RE.test(norm)) return true;
  return extraAllowed.some((o) => o.trim().replace(/\/+$/, "").toLowerCase() === norm);
}

export function allowedOriginsFromEnv(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
