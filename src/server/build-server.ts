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
        inputSchema: z.object(inputShapeFor(spec, ch.profile)),
        annotations: buildAnnotations(spec),
      },
      wrapHandler(spec, ctx, ch),
    );
  }
  return server;
}
