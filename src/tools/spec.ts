import type { z } from "zod";
import type Database from "better-sqlite3";
import type { UsageDb, Session } from "../store/usage-db.js";
import type { TextResult } from "../core/result.js";
import { SERVICE_NAME } from "../version.js";

// PlayMCP 는 description 을 1,024자 이하로 요구한다
export const DESCRIPTION_MAX = 1024;

export interface ToolContext {
  corpus: Database.Database;
  usage: UsageDb;
  session: Session;
}

export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolAnnotations extends ToolHints {
  title: string;
}

export interface ToolSpec<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  summary: string;
  purpose: string;
  usage: string;
  response: string;
  rules: string;
  input: Shape;
  annotations: ToolHints;
  hiddenInPlaymcp?: boolean;
  liteDefaults?: Record<string, unknown>;
  handler: (args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext) => Promise<TextResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): ToolSpec<Shape> {
  return spec;
}

export function buildDescription(spec: ToolSpec<z.ZodRawShape>): string {
  return (
    `${SERVICE_NAME}의 ${spec.name} 도구는 ${spec.summary}\n\n` +
    `[Purpose]\n${spec.purpose}\n\n` +
    `[Usage]\n${spec.usage}\n\n` +
    `[Response]\n${spec.response}\n\n` +
    `[Rules]\n${spec.rules}`
  );
}

export function buildAnnotations(spec: ToolSpec<z.ZodRawShape>): ToolAnnotations {
  return { title: spec.title, ...spec.annotations };
}
