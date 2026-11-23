import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TOOLS } from "../tools/registry.js";
import { buildDescription, buildAnnotations, type ToolContext } from "../tools/spec.js";
import { SERVER_NAME, VERSION } from "../version.js";

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  for (const spec of TOOLS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: buildDescription(spec),
        inputSchema: z.object(spec.input),
        annotations: buildAnnotations(spec),
      },
      (args: Record<string, unknown>) => spec.handler(args, ctx),
    );
  }
  return server;
}
