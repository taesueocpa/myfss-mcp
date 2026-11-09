export interface TextResult {
  content: Array<{ type: "text"; text: string }>;
  [key: string]: unknown;
}

export const asText = (v: unknown): TextResult => ({
  content: [{ type: "text" as const, text: JSON.stringify(v, null, 1) }],
});
