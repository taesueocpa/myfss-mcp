// 배열 순서가 tools/list 순서다
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
