import { serveStdio as sdkServeStdio } from "@modelcontextprotocol/server/stdio";
import { openCorpus } from "../store/fss-db.js";
import { UsageDb, type Session } from "../store/usage-db.js";
import { buildServer } from "./build-server.js";
import { warmSearchIndex } from "../tools/search-index.js";
import { SERVER_NAME } from "../version.js";

export async function serveStdio(): Promise<void> {
  const corpus = openCorpus();
  warmSearchIndex(corpus);
  const usage = new UsageDb();
  const session: Session = { userHash: null, isOwner: true, transport: "stdio" };
  sdkServeStdio(() => buildServer({ corpus, usage, session }));
  console.error(`${SERVER_NAME} MCP 서버 시작 (stdio, dual-era)`);
}
