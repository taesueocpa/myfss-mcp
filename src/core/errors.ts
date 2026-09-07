/**
 * 오류 타입 정본 — 판정은 문자열이 아니라 타입으로.
 *
 * 이 저장소의 도구는 전부 로컬 read-only 코퍼스 조회라 계층이 얕다. "ntt_id 없음" 같은
 * 도메인 미스는 예외가 아니라 정상 응답({error: …})으로 반환한다 — 복구 안내가 모델에
 * 닿아야 하기 때문이다(not-found 는 wrong-answer 보다 낫다). 예외로 던지는 것은
 * 부팅 불가(CorpusError)와 예기치 못한 실패뿐이다.
 */

/** 코퍼스(fss.sqlite)를 열 수 없다 — stdio 부팅 중단 사유. message 에 복구 명령을 담는다. */
export class CorpusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorpusError";
  }
}

/**
 * 던져진 에러를 짧고 안정적인 분류코드로 환원한다(usage err_code 용).
 * 소비자는 usage 집계 하나 — 사람이 읽는 라벨이므로 손실 압축이어도 된다.
 */
export function classifyError(err: unknown): string {
  if (err && typeof err === "object" && (err as { name?: string }).name === "ZodError") return "validation";
  const msg = err instanceof Error ? err.message : String(err);
  return "other:" + msg.replace(/\s+/g, " ").trim().slice(0, 80);
}
