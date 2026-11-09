import { BusyError, ClientAbortedError } from "../core/errors.js";
import type { TextResult } from "../core/result.js";
import type { Session, UsageDb } from "../store/usage-db.js";

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  // setTimeout 은 2^31-1ms 를 넘으면 1ms 로 동작한다
  return Number.isInteger(n) && n >= 0 && n <= 2_147_483_647 ? n : def;
}
export const dailyCallThreshold = (): number => envInt("DAILY_CALL_THRESHOLD", 5000);
export const slowCallIntervalMs = (): number => envInt("SLOW_CALL_INTERVAL_MS", 5000);
export const slowCallMaxWaitMs = (): number => envInt("SLOW_CALL_MAX_WAIT_MS", 20_000);

function kstDay(nowMs: number): string {
  return new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
}

const fmt = (n: number): string => n.toLocaleString("en-US");
const seconds = (ms: number): string => String(Math.round(ms / 100) / 10);

export function slowBusyMessage(threshold: number, intervalMs: number): string {
  return (
    `This credential is over today's call threshold (${fmt(threshold)} calls), so calls now run one per ` +
    `${seconds(intervalMs)} seconds until midnight KST, and too many are already waiting. Send calls one at a time.`
  );
}

type Ledger = Partial<Pick<UsageDb, "callsUsed" | "callsAdd">>;

export interface DailyCallTicket {
  readonly slowed: boolean;
  commit(): void;
  annotate(result: TextResult): TextResult;
}

export interface DailyCallLimiterOptions {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = (): ClientAbortedError =>
      new ClientAbortedError("Client cancelled or disconnected — this call was not run.");
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class DailyCallLimiter {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private day = "";
  private readonly counts = new Map<string, number>();
  private readonly nextAt = new Map<string, number>();

  constructor(opts: DailyCallLimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? sleepUnlessAborted;
  }

  async enter(session: Session | undefined, ledger: Ledger, signal?: AbortSignal): Promise<DailyCallTicket | null> {
    if (!session || session.transport !== "http" || !session.userHash || session.isOwner) return null;
    const threshold = dailyCallThreshold();
    if (threshold <= 0) return null;
    const hash = session.userHash;
    const now = this.now();
    const day = kstDay(now);
    if (day !== this.day) {
      this.day = day;
      this.counts.clear();
      this.nextAt.clear();
    }
    const slowed = (this.usedToday(hash, day, ledger) ?? 0) >= threshold;
    const interval = slowCallIntervalMs();
    if (slowed) {
      const slot = Math.max(now, this.nextAt.get(hash) ?? 0);
      const wait = slot - now;
      if (wait > slowCallMaxWaitMs()) throw new BusyError(slowBusyMessage(threshold, interval), "slow");
      this.nextAt.set(hash, slot + interval);
      if (wait > 0) {
        try {
          await this.sleep(wait, signal);
        } catch (e) {
          // 마지막 예약일 때만 되돌린다. 앞 예약을 빼면 뒤 호출 간격이 깨진다
          if (this.nextAt.get(hash) === slot + interval) this.nextAt.set(hash, slot);
          throw e;
        }
      }
    }
    let committed = false;
    let counted: { day: string; n: number } | null = null;
    return {
      slowed,
      commit: () => {
        if (committed) return;
        committed = true;
        counted = this.add(hash, ledger);
      },
      annotate: (result) => {
        if (!slowed || !counted || counted.day !== day) return result;
        const dailyCalls = {
          threshold,
          used_today: counted.n,
          interval_seconds: Number(seconds(interval)),
          note: `Over today's call threshold — calls run one per ${seconds(interval)} seconds until midnight KST.`,
        };
        const [first, ...rest] = result.content;
        if (first) {
          try {
            const v: unknown = JSON.parse(first.text);
            if (v && typeof v === "object" && !Array.isArray(v)) {
              return { ...result, content: [{ ...first, text: JSON.stringify({ ...v, daily_calls: dailyCalls }, null, 1) }, ...rest] };
            }
          } catch {
          }
        }
        return { ...result, content: [...result.content, { type: "text", text: JSON.stringify({ daily_calls: dailyCalls }) }] };
      },
    };
  }

  private usedToday(hash: string, day: string, ledger: Ledger): number | null {
    const memo = this.counts.get(hash);
    if (memo !== undefined) return memo;
    let n: number;
    try {
      n = ledger.callsUsed?.(day, hash) ?? 0;
    } catch {
      return null;
    }
    this.counts.set(hash, n);
    return n;
  }

  private add(hash: string, ledger: Ledger): { day: string; n: number } {
    const day = kstDay(this.now());
    if (day !== this.day) {
      this.day = day;
      this.counts.clear();
      this.nextAt.clear();
    }
    const before = this.usedToday(hash, day, ledger);
    const n = (before ?? 0) + 1;
    if (before !== null) this.counts.set(hash, n); // 원장을 못 읽었을 때 0 을 저장하면 그날 내내 적게 센다
    try {
      ledger.callsAdd?.(day, hash);
    } catch {
    }
    return { day, n };
  }
}

let shared: DailyCallLimiter | null = null;
export function sharedDailyCallLimiter(): DailyCallLimiter {
  return (shared ??= new DailyCallLimiter());
}
export function resetSharedDailyCallLimiter(opts?: DailyCallLimiterOptions): void {
  shared = opts ? new DailyCallLimiter(opts) : null;
}
