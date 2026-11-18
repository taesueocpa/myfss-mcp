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

export function requiresCredential(body: unknown): boolean {
  const items = Array.isArray(body) ? body : [body];
  return items.some((b) => (b as { method?: unknown } | null | undefined)?.method === "tools/call");
}

export function deniedStatus(token: string | undefined): 401 | 403 {
  return token ? 403 : 401;
}

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
export function isAllowedMcpOrigin(origin: string, extraAllowed: readonly string[] = []): boolean {
  const norm = origin.trim().replace(/\/+$/, "").toLowerCase();
  if (LOCAL_ORIGIN_RE.test(norm)) return true;
  return extraAllowed.some((o) => o.trim().replace(/\/+$/, "").toLowerCase() === norm);
}

export function allowedOriginsFromEnv(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
