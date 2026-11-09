// 인메모리 카운터라 인스턴스가 여럿이면 따로 센다

export interface RateLimiter {
  limited(key: string, limit: number): boolean;
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
