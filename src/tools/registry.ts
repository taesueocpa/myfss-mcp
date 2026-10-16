/**
 * 도구 레지스트리 — 광고 표면의 유일한 정본.
 *
 * stdio·원격 서버 모두 이 배열 하나를 소비한다(src/server/build-server.ts). description 은
 * 4섹션 구조화 필드에서 합성하고, 도구 수·description 문서·랜딩 표기는 전부 여기서 파생·검증한다.
 *
 * 배열 순서 = tools/list 카탈로그 순서(결정적).
 */
import type { ToolSpec } from "./spec.js";
import { searchDocuments } from "./search-documents.js";
import { getDocument } from "./get-document.js";
import { listRecent } from "./list-recent.js";
import { listTags } from "./list-tags.js";

export const TOOLS: ReadonlyArray<ToolSpec<any>> = [
  searchDocuments,
  getDocument,
  listRecent,
  listTags,
];
