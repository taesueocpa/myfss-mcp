/**
 * ToolSpec — 도구 정의의 타입 (mykifrs 와 동형).
 *
 * description 은 자유 텍스트가 아니라 4섹션 구조화 필드(summary/purpose/usage/response/rules)에서
 * buildDescription() 으로 합성한다. [Modes]·[See also] 는 쓰지 않는다 —
 * 파라미터 귀속 서술은 zod `.describe()`, 여러 필드를 걸치는 의미론은 [Rules], 라우팅은 [Purpose] 가
 * 정본이다.
 */
import type { z } from "zod";
import type Database from "better-sqlite3";
import type { UsageDb, Session } from "../store/usage-db.js";
import type { TextResult } from "../core/result.js";
import { SERVICE_NAME } from "../version.js";

/** description 길이 래칫 — PlayMCP 개발가이드 요구(≤1,024자). 서비스명 접두를 포함한 최종 문자열 기준. */
export const DESCRIPTION_MAX = 1024;

/** 핸들러가 받는 실행 문맥 — 상태가 실재하는 핸들 셋뿐, 프레임워크 아님. */
export interface ToolContext {
  corpus: Database.Database;
  usage: UsageDb;
  session: Session;
}

/**
 * MCP 도구 동작 힌트 — PlayMCP 개발가이드가 5종 **전부** 값 지정을 요구한다.
 * `title` 은 ToolSpec.title 에서 파생하므로 여기서는 나머지 4종만 선언한다(buildAnnotations).
 */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolAnnotations extends ToolHints {
  title: string;
}

export interface ToolSpec<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  /** 사람용 한 줄 제목 (tools/list 의 title·annotations.title). */
  title: string;
  /** 1줄 요약 — 한국어 서술문("…합니다."). 서비스명 접두 뒤에 이어지므로 문장이어야 한다. */
  summary: string;
  /** [Purpose] — English(전문용어 고유명사는 한국어). 언제 쓰는지 + 형제 도구로 넘길 분기(라우팅 정본). */
  purpose: string;
  /** [Usage] — English frame + "한국어 질문" → param=value 매핑. */
  usage: string;
  /** [Response] — English. 출력 코드값 사전(리터럴은 실제 반환값 그대로). */
  response: string;
  /** [Rules] — English imperatives. 어기면 오답이 나는 소비 규율만. */
  rules: string;
  /** 파라미터 의미·허용값·기본값의 정본은 zod `.describe()`. */
  input: Shape;
  annotations: ToolHints;
  /**
   * [PlayMCP] /mcp/playmcp 채널에서 이 도구를 등록하지 않는다 — 기본 false.
   * 운영 도구(사용량 통계)처럼 PlayMCP 최종 이용자에게 가치가 없는 도구만 true. 메인 /mcp 는 무관.
   */
  hiddenInPlaymcp?: boolean;
  /**
   * [PlayMCP] 채널 기본값 — /mcp/playmcp 에서 호출자가 **명시하지 않은 인자에만** 주입한다.
   * 응답 24k 예산 안에 도구가 스스로 작게 답하게 하는 장치다(가드는 최후 보루). 새 인자를 만들지
   * 않고 스키마에 있는 인자의 기본값만 채널별로 다르게 준다 — inputSchema 는 두 채널이 동일하다.
   */
  liteDefaults?: Record<string, unknown>;
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<TextResult>;
}

/** 타입 추론 보조 — 값 변형 없음. */
export function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): ToolSpec<Shape> {
  return spec;
}

/**
 * 4섹션을 규약 형식으로 합성한다 — 광고 description 의 유일한 조립 지점.
 * 첫 문장에 서비스명을 녹여 넣는 것은 PlayMCP 심사 요구(SERVICE_NAME 주석)다.
 */
export function buildDescription(spec: ToolSpec<z.ZodRawShape>): string {
  return (
    `${SERVICE_NAME}의 ${spec.name} 도구는 ${spec.summary}\n\n` +
    `[Purpose]\n${spec.purpose}\n\n` +
    `[Usage]\n${spec.usage}\n\n` +
    `[Response]\n${spec.response}\n\n` +
    `[Rules]\n${spec.rules}`
  );
}

/** annotations 5종 — title 은 spec.title 에서 파생한다(한 값을 두 번 적지 않는다). */
export function buildAnnotations(spec: ToolSpec<z.ZodRawShape>): ToolAnnotations {
  return { title: spec.title, ...spec.annotations };
}
