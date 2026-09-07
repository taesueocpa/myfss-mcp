/**
 * /mcp 발급 토큰 원격 검증 — 토큰 원장은 eocpa.kr(Cloudflare D1)이고, 판정은 mykifrs 의
 * TokenGate 와 같은 방식이다.
 *
 * 판정 파이프라인: 관리자 토큰(로컬 timingSafeEqual, auth.ts) → 발급 토큰 원격 검증
 * (eocpa.kr/validate, fail-closed, 유효 5분·무효 1분 캐시).
 *
 * 불변식:
 *  - 검증 서버 오류·타임아웃·비정상 응답은 전부 차단(fail-closed)이며 부정 결과를 캐시하지
 *    않는다(일시 장애가 1분 차단으로 굳는 것을 막는다).
 *  - 관리자 토큰 미설정은 권한 사유가 아니다 — 관리자 경로만 꺼지고 /mcp 는 계속 잠긴다.
 */
import { isAdminToken } from "./auth.js";

export interface TokenGateConfig {
  /** 관리자 토큰(MCP_TOKEN). 미설정이면 관리자 경로만 비활성. */
  adminToken: string | undefined;
  /** 발급 토큰 검증 엔드포인트. 기본 https://eocpa.kr/validate (env TOKEN_VALIDATE_URL 로 교체 가능). */
  validateUrl: string;
  /** 서비스 식별자 — 검증 서버의 서비스별 사용량 축. 이 앱은 'fss'. */
  svc: string;
  /** 테스트 주입점 — 기본 globalThis.fetch / Date.now. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const VALID_TTL_MS = 300_000; // 유효 5분
const INVALID_TTL_MS = 60_000; // 무효 1분
const CACHE_CAP = 5000;
const VALIDATE_TIMEOUT_MS = 10_000;

export class TokenGate {
  private readonly cfg: TokenGateConfig;
  private readonly cache = new Map<string, { valid: boolean; exp: number }>();

  constructor(cfg: TokenGateConfig) {
    this.cfg = cfg;
  }

  /** 캐시 항목 수 — 상한(CACHE_CAP) 동작의 관측용. */
  get cacheSize(): number {
    return this.cache.size;
  }

  /** 관리자 토큰 일치 여부 — auth.ts isAdminToken 위임(타이밍 비의존, 미설정이면 항상 false). */
  isAdmin(token: string | undefined): boolean {
    return isAdminToken(token, this.cfg.adminToken);
  }

  /** /mcp 접근 허용 여부. */
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
      if (!r.ok) return false; // 검증 서버 오류 시 차단 (fail-closed) — 캐시하지 않는다
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
