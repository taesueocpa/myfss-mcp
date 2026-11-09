import { classifyError } from "../core/errors.js";
import type { ToolContext, ToolSpec } from "../tools/spec.js";
import type { TextResult } from "../core/result.js";
import { enforcePlaymcpBudget, clampPlaymcpErrorText } from "./playmcp-budget.js";
import type { ChannelOptions } from "./playmcp-profile.js";
import { sharedDailyCallLimiter } from "./daily-call-limit.js";

export function pickTarget(args: Record<string, unknown>): string | null {
  const cand =
    (typeof args.query === "string" && args.query.trim() ? args.query.trim() : undefined) ??
    (typeof args.dept === "string" ? args.dept : undefined) ??
    (Array.isArray(args.topics) && args.topics.length ? args.topics.join(",") : undefined) ??
    (typeof args.ntt_id === "number" ? `ntt:${args.ntt_id}` : undefined) ??
    (typeof args.board === "string" ? `board:${args.board}` : undefined);
  return cand ?? null;
}

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

export function wrapHandler(
  spec: ToolSpec<any>,
  ctx: ToolContext,
  ch: ChannelOptions = { profile: "full", mainEndpoint: "" },
): (args: Record<string, unknown>, reqCtx?: { mcpReq?: { signal?: AbortSignal } }) => Promise<TextResult> {
  return async (args, reqCtx) => {
    const t0 = Date.now();
    let status: "ok" | "error" = "ok";
    let errCode: string | undefined;
    try {
      const ticket = await sharedDailyCallLimiter().enter(ctx.session, ctx.usage, reqCtx?.mcpReq?.signal);
      ticket?.commit();
      const res = await spec.handler(args, ctx);
      return enforceBudgetOnResult(ticket ? ticket.annotate(res) : res, ch);
    } catch (e) {
      status = "error";
      errCode = classifyError(e);
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
