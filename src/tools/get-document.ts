import { z } from "zod";
import { defineTool } from "./spec.js";
import { asText } from "../core/result.js";
import { decorate, type DocRow } from "./doc-shared.js";

export const getDocument = defineTool({
  name: "get_document",
  title: "문서 전문",
  summary: "문서 전문을 반환합니다 — 첨부 HWP를 마크다운으로 변환한 본문.",
  purpose: `- To read and quote a found document — summary·snippet are never quoting grounds.`,
  usage: `1. "그 자료 본문 보여줘" → ntt_id=12345
2. "길어서 잘렸는데 이어서" → ntt_id=12345, offset_chars=60000
3. "앞부분만 짧게" → ntt_id=12345, max_chars=8000`,
  response: `- { ntt_id, date, board, source, title, nature, topics, depts, summary, url,
  attachments:[{file_name, ext, parsed}], body_total_chars, offset_chars, truncated, body }
- truncated=true means offset_chars+max_chars < body_total_chars — raise offset_chars to continue.
- Unknown id returns { error: "ntt_id {n} 없음" }.
- body = "(본문 없음)" when nothing was parsed and no HTML 본문 exists.`,
  rules: `- body = parsed attachments (parsed=true) joined under "## 첨부: {file_name}" heads;
  with no attachment body it falls back to the detail-page HTML body (mostly FSC).
- attachments with parsed=false are NOT in body — disclose the gap, never hide it.
- Continue with offset_chars; raising max_chars grows the whole response.`,
  input: {
    ntt_id: z.number().describe("search_documents/list_recent가 반환한 ntt_id"),
    // 기본값 숫자를 문구에 적지 않는다 — 채널마다 default 가 다르고(PlayMCP 18,000), 값은 스키마 default 가 정본이다.
    max_chars: z.number().optional().default(60000).describe("본문 최대 길이(자)"),
    offset_chars: z.number().optional().default(0).describe("본문 시작 오프셋 (긴 문서 이어읽기)"),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // PlayMCP 채널 기본값 — 응답 24,000자 예산 안에 드는 값. offset_chars 이어읽기와 truncated 표식으로 전체를 읽는다.
  liteDefaults: { max_chars: 18000 },
  handler: async ({ ntt_id, max_chars, offset_chars }, { corpus }) => {
    const doc = corpus.prepare(`
      SELECT ntt_id, published_at, title, nature, summary, board, source, source_url, markdown
      FROM documents WHERE ntt_id = ?`).get(ntt_id) as (DocRow & { markdown: string | null }) | undefined;
    if (!doc) return asText({ error: `ntt_id ${ntt_id} 없음` });

    const atts = corpus.prepare(`
      SELECT file_name, ext, parse_status, markdown FROM attachments
      WHERE ntt_id = ? ORDER BY file_sn`).all(ntt_id) as
      { file_name: string; ext: string; parse_status: string | null; markdown: string | null }[];

    const parts = atts
      .filter((a) => a.parse_status === "ok" && a.markdown)
      .map((a) => `## 첨부: ${a.file_name}\n\n${a.markdown}`);
    // 첨부 본문이 없으면 상세페이지 HTML 본문(documents.markdown, 주로 FSC)으로 폴백
    const full = parts.join("\n\n---\n\n") || (doc.markdown ?? "");
    const body = full.slice(offset_chars, offset_chars + max_chars);

    return asText({
      ...decorate(corpus, doc),
      attachments: atts.map((a) => ({ file_name: a.file_name, ext: a.ext, parsed: a.parse_status === "ok" })),
      body_total_chars: full.length,
      offset_chars,
      truncated: offset_chars + max_chars < full.length,
      body: body || "(본문 없음)",
    });
  },
});
