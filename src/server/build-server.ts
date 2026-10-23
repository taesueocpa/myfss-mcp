/**
 * McpServer 조립 — 레지스트리를 소비하는 유일한 지점. (MCP SDK v2)
 *
 * stdio(src/server/stdio.ts)와 원격 HTTP(src/server/http.ts)가 같은 함수를 호출한다.
 * 요청·세션마다 새로 만들어도 되는 얇은 조립이다(원격은 stateless 라 요청마다 생성).
 * serverInfo 는 src/version.ts 를 import 한다(버전 단일 원천).
 *
 * **같은 서버 하나가 두 era 를 다 섬긴다** — 2025-era(`initialize` 핸드셰이크)와
 * 2026-07-28(요청마다 `_meta` 버전·`server/discover`) 모두 이 팩토리가 만든 인스턴스가 응답한다.
 * `server/discover`·`resultType`·헤더-본문 대조·캐시 힌트는 SDK 가 처리한다.
 *
 * 프로필(playmcp-profile.ts)에 따라 카탈로그·입력 스키마 default·instructions·디스패치 채널
 * 옵션이 갈린다. 기본은 "full"(stdio·메인 /mcp).
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SERVER_NAME, VERSION } from "../version.js";
import { buildDescription, buildAnnotations, type ToolContext } from "../tools/spec.js";
import { wrapHandler } from "./dispatch.js";
import {
  catalogFor,
  channelOptions,
  buildInstructions,
  inputShapeFor,
  type McpProfile,
} from "./playmcp-profile.js";

/**
 * 2026-07-28 캐시 힌트(`ttlMs`·`cacheScope`) — 목록성 결과에만 붙는다. 도구 카탈로그·서버 역량은
 * **배포 단위로만** 바뀌고 토큰과 무관하므로 1시간 공개 캐시로 광고한다. 클라이언트가 이 힌트를
 * 지키면 대화를 열 때마다 서버를 찔러 보는 왕복이 사라진다 — 이 값이 그 절감의 크기다.
 * SDK 기본값은 `ttlMs: 0`·`private`(매 조회 신선)이라, 명시하지 않으면 절감이 없다.
 * instructions 에 날짜 앵커를 넣게 되면 이 힌트를 거둬야 한다(낡은 날짜가 캐시에 남는다).
 */
const CACHE_HINT = { ttlMs: 3_600_000, cacheScope: "public" } as const;

export function buildServer(ctx: ToolContext, opts: { profile?: McpProfile } = {}): McpServer {
  const ch = channelOptions(opts.profile ?? "full");
  const instructions = buildInstructions(ch);
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    {
      ...(instructions ? { instructions } : {}),
      cacheHints: { "tools/list": CACHE_HINT, "server/discover": CACHE_HINT },
    },
  );
  for (const spec of catalogFor(ch.profile)) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: buildDescription(spec),
        // 채널별 default 가 박힌 zod 스키마 — 광고(inputSchema)와 실제 인자 검증·기본값 주입이
        // 같은 객체에서 나온다(playmcp-profile.ts inputShapeFor).
        inputSchema: z.object(inputShapeFor(spec, ch.profile)),
        annotations: buildAnnotations(spec),
      },
      wrapHandler(spec, ctx, ch),
    );
  }
  return server;
}
