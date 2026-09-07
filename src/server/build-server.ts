/**
 * McpServer 조립 — 레지스트리를 소비하는 유일한 지점.
 *
 * stdio(src/server/stdio.ts)와 원격 HTTP(src/server/http.ts)가 같은 함수를 호출한다.
 * 요청·세션마다 새로 만들어도 되는 얇은 조립이다(원격은 stateless 라 요청마다 생성).
 * serverInfo 는 src/version.ts 를 import 한다(버전 단일 원천).
 *
 * 프로필(playmcp-profile.ts)에 따라 카탈로그·입력 스키마 default·instructions·디스패치 채널
 * 옵션이 갈린다. 기본은 "full"(stdio·메인 /mcp).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

export function buildServer(ctx: ToolContext, opts: { profile?: McpProfile } = {}): McpServer {
  const ch = channelOptions(opts.profile ?? "full");
  const instructions = buildInstructions(ch);
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, instructions ? { instructions } : {});
  for (const spec of catalogFor(ch.profile)) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: buildDescription(spec),
        inputSchema: inputShapeFor(spec, ch.profile),
        annotations: buildAnnotations(spec),
      },
      wrapHandler(spec, ctx, ch),
    );
  }
  return server;
}
