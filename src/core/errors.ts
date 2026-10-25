/**
 * 오류 타입 정본 — 판정은 문자열이 아니라 타입으로.
 *
 * 이 저장소의 도구는 전부 로컬 read-only 코퍼스 조회라 계층이 얕다. "ntt_id 없음" 같은
 * 도메인 미스는 예외가 아니라 정상 응답({error: …})으로 반환한다 — 복구 안내가 모델에
 * 닿아야 하기 때문이다(not-found 는 wrong-answer 보다 낫다). 예외로 던지는 것은
 * 부팅 불가(CorpusError), 하루 호출 기준의 감속 거절(BusyError)·대기 중 끊김(ClientAbortedError),
 * 그리고 예기치 못한 실패뿐이다.
 */

/** 코퍼스(fss.sqlite)를 열 수 없다 — stdio 부팅 중단 사유. message 에 복구 명령을 담는다. */
export class CorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusError";
  }
}

/**
 * 하루 호출 기준을 넘은 자격의 감속 대기가 너무 길어 이 호출을 돌려보낸다(server/daily-call-limit.ts).
 * 자격·인자는 멀쩡하다 — 모델이 읽고 호출을 하나씩 보내게 하는 안내다. usage err_code = `busy:slow`.
 */
export class BusyError extends Error {
  readonly scope: "slow";
  constructor(message: string, scope: "slow") {
    super(message);
    this.name = "BusyError";
    this.scope = scope;
  }
}

/** 감속 대기 중에 클라이언트가 요청을 취소했거나 연결이 끊겼다 — 이 호출은 실행하지 않았다. usage err_code = `client_aborted`. */
export class ClientAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientAbortedError";
  }
}

/**
 * 던져진 에러를 짧고 안정적인 분류코드로 환원한다(usage err_code 용).
 * 소비자는 usage 집계 하나 — 사람이 읽는 라벨이므로 손실 압축이어도 된다.
 */
export function classifyError(err: unknown): string {
  if (err instanceof BusyError) return `busy:${err.scope}`;
  if (err instanceof ClientAbortedError) return "client_aborted";
  if (err && typeof err === "object" && (err as { name?: string }).name === "ZodError") return "validation";
  const msg = err instanceof Error ? err.message : String(err);
  return "other:" + msg.replace(/\s+/g, " ").trim().slice(0, 80);
}
