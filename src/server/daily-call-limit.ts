/**
 * 하루 호출 기준 — 자격(접속 토큰)마다 하루(KST) 실행된 도구 호출 수가 기준을 넘으면 그 자격의 호출을 느리게
 * 처리한다. 거절하지 않고 늦춘다 — 일은 버리지 않는다.
 *
 * 왜: 스크립트로 한 자격을 하루 수만 번 부르는 대량 수집은 서버를 한 사람이 쓰게 만든다. AI 클라이언트로 쓰는
 * 이용은 하루 수천 번 아래라 기준에 닿지 않는다.
 *
 * 규칙:
 * - 대상: HTTP 요청의 토큰 자격(session.userHash). 관리자 토큰(is_owner)·로컬 stdio 는 밖.
 * - 세는 것: 실행에 들어간 도구 호출 전부. 감속 대기에서 돌려보낸 호출·대기 중 끊긴 호출은 세지 않는다.
 * - 기준 `DAILY_CALL_THRESHOLD`(기본 5,000, 0 = 끔)에 닿으면 그 자격의 호출 **시작 간격**을 `SLOW_CALL_INTERVAL_MS`
 *   (기본 5초 — 시간당 720건)로 벌린다. 앞에 줄 선 호출 때문에 차례가 `SLOW_CALL_MAX_WAIT_MS`(기본 20초) 너머인
 *   호출은 기다리지 않고 BusyError(`busy:slow`)로 돌려보낸다 — MCP 기본 요청 제한시간(60초) 안에 안내가 모델에 닿게.
 *   자정(KST)에 다시 0 부터다.
 * - 느려진 호출의 성공 응답에만 `daily_calls` 를 싣는다(모델이 이용자에게 느린 이유를 말할 수 있게). 기준 아래
 *   응답은 한 글자도 바뀌지 않는다.
 * - 원장: usage.sqlite `daily_calls`(재시작에도 이어진다). 프로세스는 오늘 몫을 메모리에 들고 원장에 한 건씩 더한다.
 *   원장을 못 읽거나 못 쓰면 막지 않는다 — 남용 억제이지 과금이 아니다.
 * - 기다리다 끊긴 호출은 줄의 마지막 예약이면 자기 차례를 돌려놓는다. 감속 대기 중 자정을 넘긴 호출은 실행한 날
 *   몫으로 세고 그 응답엔 daily_calls 를 싣지 않는다(새 날엔 기준 아래다).
 * - 한 사람이 토큰을 여럿 쓰면 각각 기준을 받는다 — 이용약관(여러 자격으로 나눠 쓰기 금지)과 토큰 사용 중지로 다룬다.
 */
import { BusyError, ClientAbortedError } from "../core/errors.js";
import type { TextResult } from "../core/result.js";
import type { Session, UsageDb } from "../store/usage-db.js";

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  // setTimeout 은 2^31-1ms 를 넘으면 1ms 로 떨어진다 — 그 위는 설정 실수로 보고 기본값.
  return Number.isInteger(n) && n >= 0 && n <= 2_147_483_647 ? n : def;
}
/** 하루 호출 기준(자격마다). 0 = 끔. */
export const dailyCallThreshold = (): number => envInt("DAILY_CALL_THRESHOLD", 5000);
/** 기준을 넘은 자격의 호출 시작 간격(ms). */
export const slowCallIntervalMs = (): number => envInt("SLOW_CALL_INTERVAL_MS", 5000);
/** 감속 대기 상한(ms) — 넘을 호출은 busy:slow 로 돌려보낸다. */
export const slowCallMaxWaitMs = (): number => envInt("SLOW_CALL_MAX_WAIT_MS", 20_000);

/** KST(UTC+9) 날짜. */
function kstDay(nowMs: number): string {
  return new Date(nowMs + 9 * 3_600_000).toISOString().slice(0, 10);
}

const fmt = (n: number): string => n.toLocaleString("en-US");
const seconds = (ms: number): string => String(Math.round(ms / 100) / 10);

/** 감속 대기가 길어 돌려보낼 때의 안내(영문). */
export function slowBusyMessage(threshold: number, intervalMs: number): string {
  return (
    `This credential is over today's call threshold (${fmt(threshold)} calls), so calls now run one per ` +
    `${seconds(intervalMs)} seconds until midnight KST, and too many are already waiting. Send calls one at a time.`
  );
}

type Ledger = Partial<Pick<UsageDb, "callsUsed" | "callsAdd">>;

/** 한 호출의 기준 처리 결과 — enter 가 돌려준다. */
export interface DailyCallTicket {
  /** 이 호출이 기준을 넘어 감속됐는가. */
  readonly slowed: boolean;
  /** 실행에 들어갈 때 부른다 — 실행한 날(KST)의 호출 수에 1을 더한다(여러 번 불러도 한 번). */
  commit(): void;
  /**
   * 감속된 호출의 성공 결과에 daily_calls 를 싣는다 — 첫 블록이 JSON 객체면 그 필드로(도구 출구와 같은 직렬화),
   * 아니면 text 블록 하나를 덧붙인다. 감속되지 않았거나 자정을 넘겨 새 날 몫으로 센 호출이면 결과를 그대로 돌려준다.
   */
  annotate(result: TextResult): TextResult;
}

export interface DailyCallLimiterOptions {
  now?: () => number;
  /** 주입점 — 기본은 abort 신호를 듣는 setTimeout. */
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
  /** 메모리 몫이 가리키는 KST 날짜 — 바뀌면 두 표를 비운다. */
  private day = "";
  /** 자격 해시 → 오늘 실행된 호출 수(원장 사본 — 처음 볼 때 원장에서 읽는다). */
  private readonly counts = new Map<string, number>();
  /** 자격 해시 → 다음 호출이 시작해도 되는 시각(감속 중인 자격만). */
  private readonly nextAt = new Map<string, number>();

  constructor(opts: DailyCallLimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? sleepUnlessAborted;
  }

  /**
   * 호출 실행 전에 부른다. 대상이 아니면 null. 기준을 넘은 자격이면 차례까지 기다리고(끊기면 ClientAbortedError),
   * 차례가 너무 멀면 BusyError(busy:slow) 를 던진다.
   */
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
          // 기다리다 끊긴 호출은 자기 차례를 돌려놓는다 — 줄의 마지막 예약일 때만(앞 예약을 빼면 뒤 호출의 간격이 깨진다).
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
            /* JSON 이 아닌 결과 — 아래에서 블록을 덧붙인다 */
          }
        }
        return { ...result, content: [...result.content, { type: "text", text: JSON.stringify({ daily_calls: dailyCalls }) }] };
      },
    };
  }

  /**
   * 그날 이 자격이 실행한 호출 수. 메모리에 없으면 원장에서 읽는다. 못 읽으면 null(막지 않는다 — 0 으로 다룬다)이고
   * 메모하지 않는다: 0 을 메모하면 일시적 오류 하나로 그날 내내 덜 센다(다음 호출이 다시 읽는다).
   */
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

  /** 실행된 호출 1건을 **실행한 날**(지금의 KST 날짜) 몫으로 더하고 그 날과 더한 뒤의 수를 돌려준다. 원장 기록 실패는 삼킨다. */
  private add(hash: string, ledger: Ledger): { day: string; n: number } {
    const day = kstDay(this.now());
    if (day !== this.day) {
      this.day = day;
      this.counts.clear();
      this.nextAt.clear();
    }
    const before = this.usedToday(hash, day, ledger);
    const n = (before ?? 0) + 1;
    if (before !== null) this.counts.set(hash, n); // 원장을 못 읽었으면 메모하지 않는다(위)
    try {
      ledger.callsAdd?.(day, hash);
    } catch {
      /* 원장 기록 실패는 응답을 깨지 않는다 */
    }
    return { day, n };
  }
}

let shared: DailyCallLimiter | null = null;
/** 서버 프로세스 하나에 하나 — 디스패치(dispatch.ts)가 쓴다. */
export function sharedDailyCallLimiter(): DailyCallLimiter {
  return (shared ??= new DailyCallLimiter());
}
/** 시험용 — 공유 인스턴스를 비우거나 주입한 시계로 바꾼다. */
export function resetSharedDailyCallLimiter(opts?: DailyCallLimiterOptions): void {
  shared = opts ? new DailyCallLimiter(opts) : null;
}
