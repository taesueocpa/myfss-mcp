/**
 * IP당 고정 1분 창 레이트리미터 — windowCounter 팩토리 1개.
 *
 * 버킷 키에 접두를 붙여 경로별 한도를 달리 쓸 수 있다. 인메모리·프로세스 로컬(단일 인스턴스 전제).
 */

export interface RateLimiter {
  /** true = 한도 초과(차단). */
  limited(key: string, limit: number): boolean;
  /** 테스트·종료용 — 청소 타이머 해제. */
  stop(): void;
}

export function createRateLimiter(opts: { now?: () => number; sweepMs?: number } = {}): RateLimiter {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, { count: number; windowStart: number }>();
  const sweep = setInterval(() => {
    const cutoff = now() - 120_000;
    for (const [k, h] of hits) if (h.windowStart < cutoff) hits.delete(k);
  }, opts.sweepMs ?? 60_000);
  sweep.unref?.();
  return {
    limited(key, limit) {
      const t = now();
      const h = hits.get(key);
      if (!h || t - h.windowStart > 60_000) {
        hits.set(key, { count: 1, windowStart: t });
        return false;
      }
      h.count++;
      return h.count > limit;
    },
    stop() {
      clearInterval(sweep);
    },
  };
}
