/**
 * 디스패치 — 핸들러 앞뒤의 고정 시퀀스 (명명 함수, 프레임워크 아님).
 *
 * 시퀀스: 핸들러 실행 → [playmcp] 응답 예산 집행 → (실패 시 오류 분류 · [playmcp] 오류 문구 클램프)
 *        → finally 에 usage 기록. 기록은 호출 1건=1행이고 절대 예외를 내지 않는다(sink 소유).
 * full 프로필(메인 /mcp·stdio)은 채널 처리가 전부 꺼진 경로다.
 * 채널 기본값(lite)은 여기가 아니라 스키마다(playmcp-profile.ts inputShapeFor).
 */
import { classifyError } from "../core/errors.js";
import type { ToolContext, ToolSpec } from "../tools/spec.js";
import type { TextResult } from "../core/result.js";
import { enforcePlaymcpBudget, clampPlaymcpErrorText } from "./playmcp-budget.js";
import type { ChannelOptions } from "./playmcp-profile.js";

/** 도구 호출에서 포렌식용 조회 대상 1개를 뽑는다(검색어·문서번호 등). 운영자에게만 노출된다. */
export function pickTarget(args: Record<string, unknown>): string | null {
  const cand =
    (typeof args.query === "string" && args.query.trim() ? args.query.trim() : undefined) ??
    (typeof args.dept === "string" ? args.dept : undefined) ??
    (Array.isArray(args.topics) && args.topics.length ? args.topics.join(",") : undefined) ??
    (typeof args.ntt_id === "number" ? `ntt:${args.ntt_id}` : undefined) ??
    (typeof args.board === "string" ? `board:${args.board}` : undefined);
  return cand ?? null;
}

/**
 * [PlayMCP] 텍스트 결과에 예산을 집행한다. 도구 출구(asText)는 들여쓰기 1 로 직렬화하는데
 * 이 채널은 자 수가 곧 예산이라 **컴팩트로 재직렬화**한다 — 메인 채널의 유선 계약은 그대로다.
 * JSON 이 아닌 텍스트(도구가 만들 일은 없다)는 원시 문자열로 취급해 같은 가드를 태운다.
 */
export function enforceBudgetOnResult(res: TextResult, ch: ChannelOptions): TextResult {
  if (!ch.budget) return res;
  const content = res.content.map((c) => {
    let value: unknown;
    try {
      value = JSON.parse(c.text);
    } catch {
      value = c.text;
    }
    const { result } = enforcePlaymcpBudget(value, ch.budget!, ch.mainEndpoint);
    return { ...c, text: JSON.stringify(result) };
  });
  return { ...res, content };
}

/** 핸들러를 감싸 usage.sqlite 에 호출 1건을 기록한다(status·소요시간·검색어·이용자 해시). */
export function wrapHandler(
  spec: ToolSpec<any>,
  ctx: ToolContext,
  ch: ChannelOptions = { profile: "full", mainEndpoint: "" },
): (args: Record<string, unknown>) => Promise<TextResult> {
  return async (args) => {
    const t0 = Date.now();
    let status: "ok" | "error" = "ok";
    let errCode: string | undefined;
    try {
      return enforceBudgetOnResult(await spec.handler(args, ctx), ch);
    } catch (e) {
      status = "error";
      errCode = classifyError(e);
      // isError 응답도 Tool Response 다 — 이 채널에선 오류 문구도 예산 안이어야 한다.
      if (ch.budget && e instanceof Error) e.message = clampPlaymcpErrorText(e.message, ch.budget);
      throw e;
    } finally {
      ctx.usage.record({
        tool: spec.name,
        transport: ctx.session.transport,
        status,
        durationMs: Date.now() - t0,
        userHash: ctx.session.userHash,
        isOwner: ctx.session.isOwner,
        target: pickTarget(args),
        errCode,
        client: ctx.session.client,
      });
    }
  };
}
