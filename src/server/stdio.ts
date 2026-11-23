import { serveStdio as sdkServeStdio } from "@modelcontextprotocol/server/stdio";
import { openCorpus } from "../store/fss-db.js";
import { warmSearchIndex } from "../tools/search-index.js";
import { SERVER_NAME } from "../version.js";
import { buildServer } from "./build-server.js";

export async function serveStdio(): Promise<void> {
  const corpus = openCorpus();
  warmSearchIndex(corpus);
  sdkServeStdio(() => buildServer({ corpus }));
  console.error(`${SERVER_NAME} MCP (stdio)`);
}
