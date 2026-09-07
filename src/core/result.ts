/**
 * 도구 결과 직렬화 정본 — 모든 도구 핸들러의 유일한 출구.
 * 메인 채널은 들여쓰기 1 로 직렬화한다(유선 계약). PlayMCP 채널은 dispatch 가 컴팩트로 재직렬화한다.
 */

export interface TextResult {
  content: Array<{ type: "text"; text: string }>;
  [key: string]: unknown; // SDK CallToolResult 와의 구조적 호환(passthrough 인덱스 시그니처)
}

/** 값을 MCP 텍스트 결과로 감싼다. 모든 도구 핸들러의 유일한 출구. */
export const asText = (v: unknown): TextResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 1) }],
});
