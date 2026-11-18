import { isAdminToken } from "./auth.js";

export interface TokenGateConfig {
  adminToken: string | undefined;
  validateUrl: string;
  svc: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const VALID_TTL_MS = 300_000;
const INVALID_TTL_MS = 60_000;
const CACHE_CAP = 5000;
const VALIDATE_TIMEOUT_MS = 10_000;

export class TokenGate {
  private readonly cfg: TokenGateConfig;
  private readonly cache = new Map<string, { valid: boolean; exp: number }>();

  constructor(cfg: TokenGateConfig) {
    this.cfg = cfg;
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  isAdmin(token: string | undefined): boolean {
    return isAdminToken(token, this.cfg.adminToken);
  }

  async authorize(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    if (this.isAdmin(token)) return true;

    const now = (this.cfg.now ?? Date.now)();
    const cached = this.cache.get(token);
    if (cached && cached.exp > now) return cached.valid;
    try {
      const doFetch = this.cfg.fetchImpl ?? fetch;
      const r = await doFetch(
        `${this.cfg.validateUrl}?key=${encodeURIComponent(token)}&svc=${encodeURIComponent(this.cfg.svc)}`,
        { signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) },
      );
      if (!r.ok) return false;
      const { valid } = (await r.json()) as { valid: boolean };
      this.cache.set(token, { valid, exp: now + (valid ? VALID_TTL_MS : INVALID_TTL_MS) });
      if (this.cache.size > CACHE_CAP) this.cache.clear();
      return valid;
    } catch (err) {
      console.error("토큰 검증 오류:", err);
      return false;
    }
  }
}
