/**
 * [PlayMCP] 서빙 프로필 — "full"(메인 /mcp, 무절단)과 "playmcp"(/mcp/playmcp).
 *
 * 두 프로필의 차이는 셋뿐이고 전부 여기서 파생한다(정본은 레지스트리의 ToolSpec 선언):
 *  ① 카탈로그 — hiddenInPlaymcp 도구는 playmcp 프로필에 등록하지 않는다.
 *  ② lite 기본값 — liteDefaults 가 선언된 인자는 이 채널의 inputSchema 에서 `.default()` 만 그 값으로
 *     바뀐다(inputShapeFor) — 광고되는 default 와 실제 적용값이 늘 같다.
 *  ③ 응답 예산 — playmcp-budget.ts 가드가 봉투 직전에 걸린다(dispatch.ts).
 * 인증·usage 로깅·레이트리밋은 두 경로가 공통이다(http.ts).
 */
import { z } from "zod";
import { TOOLS } from "../tools/registry.js";
import type { ToolSpec } from "../tools/spec.js";
import { playmcpBudgetFromEnv, type PlaymcpBudget } from "./playmcp-budget.js";

export type McpProfile = "full" | "playmcp";

/** 상한 없는 표준 엔드포인트 — 절단 안내문·instructions 가 가리키는 복구 경로. */
export const MAIN_ENDPOINT = "https://myfss.eocpa.kr/mcp";

/** 프로필별 서빙 옵션 — full 은 채널 처리가 전부 꺼진 상태(budget 없음). */
export interface ChannelOptions {
  profile: McpProfile;
  budget?: PlaymcpBudget;
  mainEndpoint: string;
}

export function channelOptions(profile: McpProfile): ChannelOptions {
  return {
    profile,
    budget: profile === "playmcp" ? playmcpBudgetFromEnv() : undefined,
    mainEndpoint: MAIN_ENDPOINT,
  };
}

/** 이 프로필이 등록하는 도구 목록 — 정본은 레지스트리(ToolSpec.hiddenInPlaymcp)다. */
export function catalogFor(profile: McpProfile): ReadonlyArray<ToolSpec<any>> {
  return profile === "playmcp" ? TOOLS.filter((t) => !t.hiddenInPlaymcp) : TOOLS;
}

/** instructions 고지용 한 줄 — "key=value, …". */
export function describeLiteDefaults(tool: Pick<ToolSpec, "liteDefaults">): string | null {
  const d = tool.liteDefaults;
  if (!d) return null;
  return Object.entries(d)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
}

/**
 * 이 프로필의 도구 입력 스키마 — playmcp 면 liteDefaults 키의 `.default()` 를 채널 값으로 바꾼 사본,
 * 아니면 원본 그대로(동일 참조). 명시 인자는 당연히 이긴다(default 는 미지정에만 적용).
 * 스키마에 없는 인자를 lite 로 선언하면 부팅에서 즉시 실패시킨다 — 조용히 무시되는 선언이 최악이다.
 */
export function inputShapeFor(
  spec: Pick<ToolSpec, "name" | "input" | "liteDefaults">,
  profile: McpProfile,
): z.ZodRawShape {
  if (profile !== "playmcp" || !spec.liteDefaults) return spec.input;
  const out: Record<string, z.ZodTypeAny> = { ...(spec.input as Record<string, z.ZodTypeAny>) };
  for (const [k, v] of Object.entries(spec.liteDefaults)) {
    const field = out[k];
    if (!field) throw new Error(`${spec.name}: liteDefaults.${k} 는 inputSchema 에 없는 인자다`);
    const base = (field instanceof z.ZodDefault ? field.removeDefault() : field) as z.ZodTypeAny;
    out[k] = base.default(v);
  }
  return out;
}

/**
 * 서버 instructions — playmcp 프로필에만 붙는다(메인 /mcp 는 instructions 없음).
 * 가드 존재를 모델이 미리 알아야 `playmcp_truncated` 를 보고 스스로 인자를 좁혀 재조회한다.
 * lite 목록·미등록 도구는 레지스트리에서 생성한다 — 손으로 적으면 값이 바뀔 때 조용한 오답이 된다.
 */
export function buildInstructions(opts: ChannelOptions): string | undefined {
  if (opts.profile !== "playmcp" || !opts.budget) return undefined;
  const b = opts.budget;
  const unitLabel = b.unit === "chars" ? "chars(자)" : "bytes";
  const liteLines = TOOLS.filter((t) => t.liteDefaults)
    .map((t) => `  - ${t.name}: ${describeLiteDefaults(t)}`)
    .join("\n");
  const hidden = TOOLS.filter((t) => t.hiddenInPlaymcp).map((t) => t.name);
  return (
    `## Response Budget (this channel)\n\n` +
    `This endpoint (/mcp/playmcp) enforces a per-response budget of ` +
    `${b.limit.toLocaleString("en-US")} ${unitLabel} for the PlayMCP platform. Oversized results are ` +
    `structurally truncated instead of failing: check \`playmcp_truncated: true\` and ` +
    `\`playmcp_truncation_note\` in the result, and re-query with narrower args (limit·context·offset) ` +
    `to page through the rest. The standard endpoint ${opts.mainEndpoint} serves every tool with no budget.` +
    (liteLines
      ? `\n\n### Channel defaults\n\n` +
        `To stay inside that budget, some arguments have **smaller defaults on this channel than on the ` +
        `standard endpoint** (this channel's inputSchema already shows the channel default). They apply ONLY ` +
        `when you omit the argument — pass it explicitly and your value wins (the budget guard still applies ` +
        `afterwards). Each tool reports what it cut in its own response (truncated·total 등):\n\n` +
        liteLines
      : "") +
    (hidden.length
      ? `\n\n### Not listed here\n\n${hidden.join(", ")} — not registered in this channel ` +
        `(server usage statistics, not corpus data). Use ${opts.mainEndpoint} if you need it.`
      : "")
  );
}
