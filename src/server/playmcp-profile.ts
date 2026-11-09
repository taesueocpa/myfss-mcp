import { z } from "zod";
import { TOOLS } from "../tools/registry.js";
import type { ToolSpec } from "../tools/spec.js";
import { playmcpBudgetFromEnv, type PlaymcpBudget } from "./playmcp-budget.js";

export type McpProfile = "full" | "playmcp";

export const MAIN_ENDPOINT = "https://myfss.eocpa.kr/mcp";

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

export function catalogFor(profile: McpProfile): ReadonlyArray<ToolSpec<any>> {
  return profile === "playmcp" ? TOOLS.filter((t) => !t.hiddenInPlaymcp) : TOOLS;
}

export function describeLiteDefaults(tool: Pick<ToolSpec, "liteDefaults">): string | null {
  const d = tool.liteDefaults;
  if (!d) return null;
  return Object.entries(d)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
}

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
      ? `\n\n### Not listed here\n\n${hidden.join(", ")} — not registered in this channel. ` +
        `Use ${opts.mainEndpoint} if you need it.`
      : "")
  );
}
