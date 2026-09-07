import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";

/**
 * 사용량 통계 — 요청자에 따라 차등 노출.
 * 운영자(관리자 토큰/로컬 stdio): 이용자별 행태·인기 검색어까지 전부(detailed).
 * 그 외 이용자: 도구별 인기·전체 호출수·일별 추이만(aggregate — 남의 검색어·프로필 비노출).
 * 요청자 등급이 응답을 가르는 의미론은 [Rules] 가 정본이다.
 *
 * 운영 도구라 PlayMCP 채널에는 등록하지 않는다(hiddenInPlaymcp) — 최종 이용자에게 가치가 없고
 * 도구 선택 정확도만 떨어뜨린다. 메인 /mcp·stdio 에서는 그대로 제공된다.
 */
export const getUsageStats = defineTool({
  name: "get_usage_stats",
  title: "사용량 통계",
  summary: "이 MCP 서버의 도구 사용량 통계를 반환합니다.",
  purpose: `- Per-tool usage·latency (avg/percentiles)·error rate·daily trend.`,
  usage: `1. "최근 30일 사용량" → (인자 없음)
2. "지난 7일만" → days=7
3. "전체 기간" → days=0`,
  response: `- Both tiers: { visibility, period:{days, since, until}, overview:{total_calls, unique_users, errors,
  error_rate, p50_ms, p90_ms, p99_ms}, by_tool:[{tool, calls, errors, error_rate, avg_ms, p99_ms, users}],
  by_day:[{day, calls}] }
- visibility="public" adds \`note\`; period.days = "all" when days=0.
- visibility="operator" adds users:[{user, is_owner, calls, distinct_tools, first_seen, last_seen,
  tools:[{tool, calls, avg_ms}]}] and top_targets:[{target, tool, calls, users}].`,
  rules: `- Tier by requester: admin token·local stdio → "operator", else "public".
- users·top_targets exist only at operator tier — absence ≠ 0.
- \`user\` is a truncated SHA-256 of the 접속 토큰 — not a person. stdio calls (no hash) never appear.
- Timings = server-side handler time (no network).`,
  input: {
    days: z.number().optional().default(30).describe("최근 N일 윈도 (0이면 전체 기간, 기본 30)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  hiddenInPlaymcp: true,
  handler: async ({ days }, { usage, session }) => {
    if (session.isOwner) {
      return asText({ visibility: "operator", ...usage.detailed({ days }) });
    }
    return asText({
      visibility: "public",
      note: "공개 집계입니다. 이용자별 상세·인기 검색어는 서버 운영자에게만 제공됩니다.",
      ...usage.aggregate({ days }),
    });
  },
});
